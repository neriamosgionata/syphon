"""Walk-forward training loop for TradingTransformer."""

import time
import json
import logging
from pathlib import Path
from datetime import datetime

import numpy as np
import pandas as pd
import torch
from torch.utils.data import DataLoader
from torch.cuda.amp import GradScaler, autocast

from ..models.transformer import TradingTransformer, MultiTaskLoss, build_model, build_loss
from ..data.features import compute_features, compute_targets, FEATURE_COLUMNS
from ..data.dataset import build_dataset
from ..data.kraken import load_pair
from .metrics import compute_all_metrics, collect_predictions

logger = logging.getLogger(__name__)


class Trainer:
    """Walk-forward trainer for TradingTransformer.

    Walk-forward: train on N days, validate on next M days, slide forward.
    This prevents look-ahead bias in time-series data.
    """

    def __init__(self, config: dict, checkpoint_dir: str = "./checkpoints"):
        self.config = config
        self.checkpoint_dir = Path(checkpoint_dir)
        self.checkpoint_dir.mkdir(parents=True, exist_ok=True)

        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.use_amp = self.device.type == "cuda"

        # Training config
        train_cfg = config.get("training", {})
        self.batch_size = train_cfg.get("batch_size", 256)
        self.epochs = train_cfg.get("epochs", 100)
        self.lr = train_cfg.get("lr", 1e-4)
        self.weight_decay = train_cfg.get("weight_decay", 1e-5)
        self.grad_clip = train_cfg.get("grad_clip", 1.0)
        self.patience = train_cfg.get("patience", 10)
        self.train_days = train_cfg.get("walk_forward_train_days", 30)
        self.val_days = train_cfg.get("val_days", 7)

        # Data config
        data_cfg = config.get("data", {})
        self.seq_len = data_cfg.get("seq_len", 120)
        self.stride = data_cfg.get("stride", 1)
        self.pairs = data_cfg.get("pairs", ["XXBTZUSD"])

        self.progress_callback = None
        self._stop_requested = False

    def stop(self):
        """Request training to stop after current epoch."""
        self._stop_requested = True

    def _prepare_pair_data(self, pair: str, data_dir: str = "./data"):
        """Load and prepare features + targets for a pair."""
        df = load_pair(pair, data_dir=data_dir)
        features = compute_features(df)
        targets = compute_targets(df)

        # Align indices
        common_idx = features.index.intersection(targets.index)
        features = features.loc[common_idx]
        targets = targets.loc[common_idx]

        return features, targets

    def _get_walk_forward_splits(
        self, index: pd.DatetimeIndex
    ) -> list[tuple[pd.Timestamp, pd.Timestamp, pd.Timestamp]]:
        """Generate walk-forward train/val date splits.

        Returns list of (train_start, val_start, val_end) tuples.
        """
        start = index.min()
        end = index.max()
        train_delta = pd.Timedelta(days=self.train_days)
        val_delta = pd.Timedelta(days=self.val_days)

        splits = []
        current = start
        while current + train_delta + val_delta <= end:
            train_start = current
            val_start = current + train_delta
            val_end = val_start + val_delta
            splits.append((train_start, val_start, val_end))
            current = val_start  # Slide by val window

        return splits

    def _train_one_epoch(
        self, model, optimizer, scheduler, loss_fn, loader, scaler
    ) -> float:
        """Train for one epoch, return average loss."""
        model.train()
        total_loss = 0.0
        n_batches = 0

        for features, targets in loader:
            features = features.to(self.device)
            targets = {k: v.to(self.device) for k, v in targets.items()}

            optimizer.zero_grad()

            if self.use_amp:
                with autocast():
                    predictions = model(features)
                    losses = loss_fn(predictions, targets)
                scaler.scale(losses["total"]).backward()
                scaler.unscale_(optimizer)
                torch.nn.utils.clip_grad_norm_(model.parameters(), self.grad_clip)
                scaler.step(optimizer)
                scaler.update()
            else:
                predictions = model(features)
                losses = loss_fn(predictions, targets)
                losses["total"].backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), self.grad_clip)
                optimizer.step()

            if scheduler is not None:
                scheduler.step()

            total_loss += losses["total"].item()
            n_batches += 1

        return total_loss / max(n_batches, 1)

    def _validate(self, model, loss_fn, loader) -> tuple[float, dict]:
        """Validate model, return (loss, metrics_dict)."""
        model.eval()
        total_loss = 0.0
        n_batches = 0

        preds, tgts = collect_predictions(model, loader, self.device)

        # Compute loss on full validation set
        with torch.no_grad():
            for features, targets in loader:
                features = features.to(self.device)
                targets_dev = {k: v.to(self.device) for k, v in targets.items()}
                out = model(features)
                losses = loss_fn(out, targets_dev)
                total_loss += losses["total"].item()
                n_batches += 1

        val_loss = total_loss / max(n_batches, 1)
        metrics = compute_all_metrics(preds, tgts)
        metrics["val_loss"] = val_loss

        return val_loss, metrics

    def train(
        self, data_dir: str = "./data", progress_callback=None
    ) -> dict:
        """Run full walk-forward training across all pairs.

        Returns dict with best model path, metrics history, and training summary.
        """
        self.progress_callback = progress_callback
        self._stop_requested = False
        start_time = time.time()

        # Prepare data for all pairs
        all_features = []
        all_targets = []
        for pair in self.pairs:
            logger.info(f"Loading {pair}...")
            feat, tgt = self._prepare_pair_data(pair, data_dir)
            # Add pair identifier for multi-pair training
            all_features.append(feat)
            all_targets.append(tgt)

        # Concatenate all pairs (they share the same feature columns)
        features_df = pd.concat(all_features).sort_index()
        targets_df = pd.concat(all_targets).sort_index()

        # Walk-forward splits
        splits = self._get_walk_forward_splits(features_df.index)
        logger.info(f"Walk-forward: {len(splits)} folds")

        best_score = -float("inf")
        best_model_path = None
        fold_results = []

        for fold_idx, (train_start, val_start, val_end) in enumerate(splits):
            if self._stop_requested:
                logger.info("Training stopped by user")
                break

            logger.info(
                f"Fold {fold_idx+1}/{len(splits)}: "
                f"train {train_start.date()} -> {val_start.date()}, "
                f"val {val_start.date()} -> {val_end.date()}"
            )

            # Split data
            train_mask = (features_df.index >= train_start) & (features_df.index < val_start)
            val_mask = (features_df.index >= val_start) & (features_df.index < val_end)

            train_feat = features_df.loc[train_mask]
            train_tgt = targets_df.loc[train_mask]
            val_feat = features_df.loc[val_mask]
            val_tgt = targets_df.loc[val_mask]

            if len(train_feat) < self.seq_len * 2 or len(val_feat) < self.seq_len:
                logger.warning(f"  Fold {fold_idx+1}: insufficient data, skipping")
                continue

            # Build datasets (normalize using train stats only)
            train_ds, scaler_params = build_dataset(
                train_feat, train_tgt, seq_len=self.seq_len, stride=self.stride
            )

            # Apply train normalization to validation
            val_arr = val_feat.values.astype(np.float32)
            if scaler_params is not None:
                mean, std = scaler_params
                val_arr = (val_arr - mean) / std

            val_target_dict = {
                col: val_tgt[col].values.astype(np.float32)
                for col in val_tgt.columns
            }
            from ..data.dataset import TradingDataset
            val_ds = TradingDataset(val_arr, val_target_dict, seq_len=self.seq_len, stride=self.seq_len // 2)

            if len(train_ds) == 0 or len(val_ds) == 0:
                logger.warning(f"  Fold {fold_idx+1}: empty dataset, skipping")
                continue

            train_loader = DataLoader(
                train_ds, batch_size=self.batch_size, shuffle=True,
                num_workers=0, pin_memory=self.device.type == "cuda"
            )
            val_loader = DataLoader(
                val_ds, batch_size=self.batch_size, shuffle=False,
                num_workers=0, pin_memory=self.device.type == "cuda"
            )

            # Compute class weights for imbalanced direction labels
            dir_labels = train_tgt.loc[train_mask, "direction"].dropna().values
            class_counts = np.bincount(dir_labels.astype(int), minlength=3).astype(float)
            class_counts[class_counts == 0] = 1
            class_weights = torch.tensor(
                len(dir_labels) / (3 * class_counts), dtype=torch.float32
            ).to(self.device)

            # Build model and optimizer fresh for each fold
            model = build_model(self.config).to(self.device)
            loss_fn = build_loss(self.config, class_weights)
            optimizer = torch.optim.AdamW(
                model.parameters(), lr=self.lr, weight_decay=self.weight_decay
            )
            total_steps = len(train_loader) * self.epochs
            scheduler = torch.optim.lr_scheduler.OneCycleLR(
                optimizer, max_lr=self.lr, total_steps=total_steps
            )
            scaler = GradScaler(enabled=self.use_amp)

            # Training loop with early stopping
            best_fold_score = -float("inf")
            patience_counter = 0
            fold_metrics_history = []

            for epoch in range(self.epochs):
                if self._stop_requested:
                    break

                train_loss = self._train_one_epoch(
                    model, optimizer, scheduler, loss_fn, train_loader, scaler
                )
                val_loss, val_metrics = self._validate(model, loss_fn, val_loader)

                # Score = direction_accuracy * sharpe (balanced metric)
                score = val_metrics["direction_accuracy"] * max(val_metrics["sharpe"], 0.01)

                fold_metrics_history.append({
                    "epoch": epoch + 1,
                    "train_loss": train_loss,
                    "val_loss": val_loss,
                    **val_metrics,
                })

                if self.progress_callback:
                    self.progress_callback({
                        "fold": fold_idx + 1,
                        "total_folds": len(splits),
                        "epoch": epoch + 1,
                        "total_epochs": self.epochs,
                        "train_loss": train_loss,
                        "val_loss": val_loss,
                        "direction_accuracy": val_metrics["direction_accuracy"],
                        "sharpe": val_metrics["sharpe"],
                    })

                if score > best_fold_score:
                    best_fold_score = score
                    patience_counter = 0
                    # Save if best across all folds
                    if score > best_score:
                        best_score = score
                        best_model_path = self.checkpoint_dir / "best_model.pt"
                        torch.save({
                            "model_state_dict": model.state_dict(),
                            "config": self.config,
                            "scaler_params": scaler_params,
                            "fold": fold_idx,
                            "epoch": epoch + 1,
                            "val_metrics": val_metrics,
                            "trained_at": datetime.utcnow().isoformat(),
                        }, best_model_path)
                else:
                    patience_counter += 1
                    if patience_counter >= self.patience:
                        logger.info(f"  Early stopping at epoch {epoch+1}")
                        break

                if (epoch + 1) % 10 == 0:
                    logger.info(
                        f"  Epoch {epoch+1}: train_loss={train_loss:.4f} "
                        f"val_loss={val_loss:.4f} acc={val_metrics['direction_accuracy']:.3f} "
                        f"sharpe={val_metrics['sharpe']:.2f}"
                    )

            fold_results.append({
                "fold": fold_idx + 1,
                "train_period": f"{train_start.date()} to {val_start.date()}",
                "val_period": f"{val_start.date()} to {val_end.date()}",
                "best_score": best_fold_score,
                "epochs_trained": len(fold_metrics_history),
                "final_metrics": fold_metrics_history[-1] if fold_metrics_history else {},
            })

        elapsed = time.time() - start_time

        summary = {
            "best_model_path": str(best_model_path) if best_model_path else None,
            "best_score": best_score,
            "folds_completed": len(fold_results),
            "total_folds": len(splits),
            "training_time_seconds": elapsed,
            "pairs": self.pairs,
            "fold_results": fold_results,
        }

        # Save summary
        summary_path = self.checkpoint_dir / "training_summary.json"
        with open(summary_path, "w") as f:
            json.dump(summary, f, indent=2, default=str)

        logger.info(f"Training complete in {elapsed:.0f}s. Best score: {best_score:.4f}")
        return summary
