#!/usr/bin/env python3
"""Backtest a trained model on held-out data."""

import argparse
import json
import logging
import sys
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.models.transformer import build_model
from src.data.kraken import load_pair
from src.data.features import compute_features, compute_targets
from src.data.dataset import build_dataset, TradingDataset
from src.training.metrics import compute_all_metrics, collect_predictions
from src.utils import load_config


def main():
    parser = argparse.ArgumentParser(description="Backtest trained model")
    parser.add_argument("--config", type=str, default=None)
    parser.add_argument("--model", type=str, default=None, help="Model checkpoint path")
    parser.add_argument("--data-dir", type=str, default=None)
    parser.add_argument("--pair", type=str, nargs="+", help="Pairs to backtest")
    parser.add_argument("--days", type=int, default=30, help="Days to evaluate")
    parser.add_argument("--output", type=str, default=None, help="JSON output path")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)

    config = load_config(args.config)
    data_cfg = config.get("data", {})
    data_dir = args.data_dir or data_cfg.get("data_dir", "./data")
    seq_len = data_cfg.get("seq_len", 120)

    # Load model
    model_path = args.model or str(Path(config.get("checkpoint_dir", "./checkpoints")) / "best_model.pt")
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    checkpoint = torch.load(model_path, map_location=device, weights_only=False)
    model = build_model(checkpoint.get("config", config)).to(device)
    model.load_state_dict(checkpoint["model_state_dict"])
    model.eval()

    scaler_params = checkpoint.get("scaler_params")
    pairs = args.pair or data_cfg.get("pairs", ["XXBTZUSD"])

    print(f"Backtesting model: {model_path}")
    print(f"Pairs: {pairs}")
    print(f"Device: {device}\n")

    results = {}

    for pair in pairs:
        print(f"--- {pair} ---")
        try:
            df = load_pair(pair, data_dir=data_dir)
        except FileNotFoundError:
            print(f"  No data for {pair}, skipping\n")
            continue

        features = compute_features(df)
        targets = compute_targets(df)

        common_idx = features.index.intersection(targets.index)
        features = features.loc[common_idx]
        targets = targets.loc[common_idx]

        # Use last N days as test set
        cutoff = features.index.max() - np.timedelta64(args.days, "D")
        test_feat = features.loc[features.index >= cutoff]
        test_tgt = targets.loc[targets.index >= cutoff]

        if len(test_feat) < seq_len * 2:
            print(f"  Insufficient test data ({len(test_feat)} bars)\n")
            continue

        # Normalize
        feat_arr = test_feat.values.astype(np.float32)
        if scaler_params is not None:
            mean, std = scaler_params
            feat_arr = (feat_arr - mean) / std

        target_dict = {col: test_tgt[col].values.astype(np.float32) for col in test_tgt.columns}
        ds = TradingDataset(feat_arr, target_dict, seq_len=seq_len, stride=1)

        if len(ds) == 0:
            print(f"  No valid samples\n")
            continue

        loader = DataLoader(ds, batch_size=256, shuffle=False)
        preds, tgts = collect_predictions(model, loader, device)
        metrics = compute_all_metrics(preds, tgts)

        results[pair] = metrics

        print(f"  Samples: {len(ds)}")
        print(f"  Direction accuracy: {metrics['direction_accuracy']:.3f}")
        print(f"    Down: {metrics.get('accuracy_down', 0):.3f}  "
              f"Flat: {metrics.get('accuracy_flat', 0):.3f}  "
              f"Up: {metrics.get('accuracy_up', 0):.3f}")
        print(f"  Sharpe: {metrics['sharpe']:.2f}")
        print(f"  Win rate: {metrics['win_rate']:.3f}")
        print(f"  Strategy return: {metrics['strategy_return']:.4f}")
        print(f"  Max drawdown: {metrics['max_drawdown']:.4f}")
        print(f"  Return correlation (3h): {metrics['corr_3h']:.3f}")
        print(f"  Confidence: mean={metrics['mean_confidence']:.3f} corr={metrics['confidence_corr']:.3f}")
        print()

    if args.output:
        with open(args.output, "w") as f:
            json.dump(results, f, indent=2)
        print(f"Results saved to {args.output}")


if __name__ == "__main__":
    main()
