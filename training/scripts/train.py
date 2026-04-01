#!/usr/bin/env python3
"""CLI entry point for model training."""

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.training.trainer import Trainer
from src.utils import load_config


def main():
    parser = argparse.ArgumentParser(description="Train TradingTransformer model")
    parser.add_argument("--config", type=str, default=None, help="Config file path")
    parser.add_argument("--data-dir", type=str, default=None, help="Data directory")
    parser.add_argument("--checkpoint-dir", type=str, default=None, help="Checkpoint directory")
    parser.add_argument("--pair", type=str, nargs="+", help="Override pairs to train on")
    parser.add_argument("--epochs", type=int, default=None, help="Override max epochs")
    parser.add_argument("--batch-size", type=int, default=None, help="Override batch size")
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    config = load_config(args.config)

    # Apply CLI overrides
    if args.pair:
        config.setdefault("data", {})["pairs"] = args.pair
    if args.epochs:
        config.setdefault("training", {})["epochs"] = args.epochs
    if args.batch_size:
        config.setdefault("training", {})["batch_size"] = args.batch_size

    data_dir = args.data_dir or config.get("data_dir", "./data")
    checkpoint_dir = args.checkpoint_dir or config.get("checkpoint_dir", "./checkpoints")

    trainer = Trainer(config, checkpoint_dir=checkpoint_dir)

    def on_progress(info):
        fold = info.get("fold", "?")
        total = info.get("total_folds", "?")
        epoch = info.get("epoch", "?")
        max_ep = info.get("total_epochs", "?")
        acc = info.get("direction_accuracy", 0)
        sharpe = info.get("sharpe", 0)
        print(
            f"\r  Fold {fold}/{total} | Epoch {epoch}/{max_ep} | "
            f"Acc: {acc:.3f} | Sharpe: {sharpe:.2f}",
            end="", flush=True,
        )

    print(f"Training on: {config.get('data', {}).get('pairs', [])}")
    print(f"Device: {trainer.device}\n")

    summary = trainer.train(data_dir=data_dir, progress_callback=on_progress)

    print(f"\n\nTraining complete!")
    print(f"  Folds: {summary['folds_completed']}/{summary['total_folds']}")
    print(f"  Best score: {summary['best_score']:.4f}")
    print(f"  Time: {summary['training_time_seconds']:.0f}s")
    if summary.get("best_model_path"):
        print(f"  Model saved: {summary['best_model_path']}")


if __name__ == "__main__":
    main()
