"""FastAPI inference server for TradingTransformer predictions."""

import asyncio
import logging
import time
from pathlib import Path
from datetime import datetime

import numpy as np
import torch
from fastapi import FastAPI, BackgroundTasks, HTTPException
from pydantic import BaseModel

from ..models.transformer import build_model
from ..data.kraken import fetch_ohlc
from ..data.features import compute_features, FEATURE_COLUMNS
from ..utils import load_config

logger = logging.getLogger(__name__)

app = FastAPI(title="Syphon Trading Model", version="1.0.0")

# Global state
_state = {
    "model": None,
    "config": None,
    "scaler_params": None,
    "device": None,
    "model_info": None,
    "training_status": None,
}


# ─── Request / Response models ──────────────────────────────

class PredictRequest(BaseModel):
    pair: str = "XXBTZUSD"

class BatchPredictRequest(BaseModel):
    pairs: list[str]

class PredictResponse(BaseModel):
    pair: str
    direction: str
    direction_probs: dict[str, float]
    returns: dict[str, float]
    confidence: float
    timestamp: str

class TrainRequest(BaseModel):
    pairs: list[str] | None = None
    backfill_days: int | None = None
    epochs: int | None = None
    batch_size: int | None = None
    learning_rate: float | None = None

class BackfillRequest(BaseModel):
    pairs: list[str] | None = None
    days: int = 90


# ─── Startup ────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    config = load_config()
    _state["config"] = config
    _state["device"] = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    checkpoint_dir = Path(config.get("checkpoint_dir", "./checkpoints"))
    model_path = checkpoint_dir / "best_model.pt"

    if model_path.exists():
        _load_model(model_path)
    else:
        logger.warning("No trained model found. Run /train first.")


def _load_model(path: Path):
    """Load a saved model checkpoint."""
    checkpoint = torch.load(path, map_location=_state["device"], weights_only=False)

    config = checkpoint.get("config", _state["config"])
    model = build_model(config).to(_state["device"])
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()

    _state["model"] = model
    _state["scaler_params"] = checkpoint.get("scaler_params")
    _state["model_info"] = {
        "version": path.stem,
        "trained_at": checkpoint.get("trained_at", "unknown"),
        "fold": checkpoint.get("fold"),
        "epoch": checkpoint.get("epoch"),
        "val_metrics": checkpoint.get("val_metrics", {}),
    }

    logger.info(f"Model loaded from {path}")


# ─── Prediction helpers ─────────────────────────────────────

def _fetch_and_predict(pair: str) -> dict:
    """Fetch latest bars from Kraken, compute features, run inference."""
    model = _state.get("model")
    if model is None:
        raise HTTPException(status_code=503, detail="No model loaded")

    config = _state["config"]
    seq_len = config.get("data", {}).get("seq_len", 120)

    # Fetch enough bars for the sequence window + warmup for indicators
    # Need ~200 bars to compute indicators that depend on rolling windows
    bars_needed = seq_len + 100
    df, _ = fetch_ohlc(pair, interval=5)

    if len(df) < seq_len + 50:
        raise HTTPException(
            status_code=422,
            detail=f"Insufficient data for {pair}: got {len(df)} bars, need {seq_len + 50}",
        )

    # Compute features
    features = compute_features(df)
    features = features[FEATURE_COLUMNS]

    # Take the last seq_len bars
    feat_arr = features.iloc[-seq_len:].values.astype(np.float32)

    # Apply normalization if scaler was saved
    scaler = _state.get("scaler_params")
    if scaler is not None:
        mean, std = scaler
        feat_arr = (feat_arr - mean) / std

    # Replace NaNs
    feat_arr = np.nan_to_num(feat_arr, nan=0.0)

    # Run inference
    tensor = torch.tensor(feat_arr, dtype=torch.float32).unsqueeze(0).to(_state["device"])
    result = model.predict(tensor)

    # Parse outputs
    dir_probs = result["direction_probs"][0].cpu().numpy()
    returns = result["returns"][0].cpu().numpy()
    confidence = result["confidence"][0, 0].cpu().item()

    direction_map = {0: "down", 1: "flat", 2: "up"}
    pred_dir = int(dir_probs.argmax())

    return {
        "pair": pair,
        "direction": direction_map[pred_dir],
        "direction_probs": {
            "down": round(float(dir_probs[0]), 4),
            "flat": round(float(dir_probs[1]), 4),
            "up": round(float(dir_probs[2]), 4),
        },
        "returns": {
            "r30m": round(float(returns[0]), 6),
            "r1h": round(float(returns[1]), 6),
            "r3h": round(float(returns[2]), 6),
        },
        "confidence": round(confidence, 4),
        "timestamp": datetime.utcnow().isoformat(),
    }


# ─── Routes ─────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": _state["model"] is not None,
        "device": str(_state.get("device", "unknown")),
    }


@app.post("/predict", response_model=PredictResponse)
async def predict(req: PredictRequest):
    return _fetch_and_predict(req.pair)


@app.post("/predict/batch")
async def predict_batch(req: BatchPredictRequest):
    results = []
    errors = []
    for pair in req.pairs:
        try:
            results.append(_fetch_and_predict(pair))
        except Exception as e:
            errors.append({"pair": pair, "error": str(e)})
    return {"predictions": results, "errors": errors}


@app.get("/model/info")
async def model_info():
    info = _state.get("model_info")
    if info is None:
        raise HTTPException(status_code=404, detail="No model loaded")
    config = _state["config"]
    return {
        **info,
        "pairs_configured": config.get("data", {}).get("pairs", []),
        "seq_len": config.get("data", {}).get("seq_len", 120),
        "d_model": config.get("model", {}).get("d_model", 128),
        "num_layers": config.get("model", {}).get("num_layers", 4),
    }


@app.post("/train")
async def trigger_train(req: TrainRequest, background_tasks: BackgroundTasks):
    if _state.get("training_status", {}).get("running"):
        raise HTTPException(status_code=409, detail="Training already in progress")

    _state["training_status"] = {"running": True, "started_at": datetime.utcnow().isoformat(), "progress": {}}

    def run_training():
        try:
            from ..training.trainer import Trainer

            config = _state["config"]
            if req.pairs:
                config = {**config, "data": {**config.get("data", {}), "pairs": req.pairs}}
            if req.epochs:
                config = {**config, "training": {**config.get("training", {}), "epochs": req.epochs}}
            if req.batch_size:
                config = {**config, "training": {**config.get("training", {}), "batch_size": req.batch_size}}
            if req.learning_rate:
                config = {**config, "training": {**config.get("training", {}), "lr": req.learning_rate}}

            trainer = Trainer(config, checkpoint_dir=config.get("checkpoint_dir", "./checkpoints"))

            def on_progress(info):
                _state["training_status"]["progress"] = info

            summary = trainer.train(
                data_dir=config.get("data_dir", "./data"),
                progress_callback=on_progress,
            )
            _state["training_status"]["running"] = False
            _state["training_status"]["completed_at"] = datetime.utcnow().isoformat()
            _state["training_status"]["summary"] = summary

            # Reload model if training produced one
            if summary.get("best_model_path"):
                _load_model(Path(summary["best_model_path"]))

        except Exception as e:
            logger.exception("Training failed")
            _state["training_status"]["running"] = False
            _state["training_status"]["error"] = str(e)

    background_tasks.add_task(run_training)
    return {"status": "started", "message": "Training started in background"}


@app.get("/train/status")
async def train_status():
    status = _state.get("training_status")
    if status is None:
        return {"running": False, "message": "No training has been started"}
    return status


@app.post("/backfill")
async def trigger_backfill(req: BackfillRequest, background_tasks: BackgroundTasks):
    if _state.get("backfill_status", {}).get("running"):
        raise HTTPException(status_code=409, detail="Backfill already in progress")

    _state["backfill_status"] = {
        "running": True,
        "started_at": datetime.utcnow().isoformat(),
        "pairs_done": [],
        "current_pair": None,
    }

    def run_backfill():
        try:
            from ..data.kraken import backfill_pair, DEFAULT_PAIRS

            config = _state["config"]
            data_cfg = config.get("data", {})
            pairs = req.pairs or data_cfg.get("pairs", DEFAULT_PAIRS)
            data_dir = data_cfg.get("data_dir", "./data")

            for pair in pairs:
                _state["backfill_status"]["current_pair"] = pair
                try:
                    df = backfill_pair(pair, days=req.days, data_dir=data_dir)
                    _state["backfill_status"]["pairs_done"].append({
                        "pair": pair,
                        "bars": len(df),
                        "status": "ok",
                    })
                except Exception as e:
                    _state["backfill_status"]["pairs_done"].append({
                        "pair": pair,
                        "bars": 0,
                        "status": f"error: {e}",
                    })

            _state["backfill_status"]["running"] = False
            _state["backfill_status"]["current_pair"] = None
            _state["backfill_status"]["completed_at"] = datetime.utcnow().isoformat()

        except Exception as e:
            logger.exception("Backfill failed")
            _state["backfill_status"]["running"] = False
            _state["backfill_status"]["error"] = str(e)

    background_tasks.add_task(run_backfill)
    return {"status": "started", "pairs": req.pairs or _state["config"].get("data", {}).get("pairs", [])}


@app.get("/backfill/status")
async def backfill_status():
    status = _state.get("backfill_status")
    if status is None:
        return {"running": False, "message": "No backfill has been started"}
    return status


@app.get("/config")
async def get_config():
    """Return the current training configuration."""
    config = _state.get("config", {})
    return {
        "data": config.get("data", {}),
        "model": config.get("model", {}),
        "training": config.get("training", {}),
        "loss_weights": config.get("loss_weights", {}),
        "targets": config.get("targets", {}),
    }
