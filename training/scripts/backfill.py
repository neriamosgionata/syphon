#!/usr/bin/env python3
"""Backfill Kraken OHLC history for configured pairs."""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from src.data.kraken import backfill_pair, DEFAULT_PAIRS
from src.utils import load_config


def main():
    parser = argparse.ArgumentParser(description="Backfill Kraken OHLC data")
    parser.add_argument("--pair", type=str, help="Single pair to backfill (e.g. XXBTZUSD)")
    parser.add_argument("--days", type=int, default=None, help="Days of history")
    parser.add_argument("--interval", type=int, default=None, help="Bar interval in minutes")
    parser.add_argument("--config", type=str, default=None, help="Config file path")
    parser.add_argument("--data-dir", type=str, default=None, help="Data directory")
    args = parser.parse_args()

    config = load_config(args.config)
    data_cfg = config.get("data", {})

    days = args.days or data_cfg.get("backfill_days", 90)
    interval = args.interval or data_cfg.get("interval", 5)
    data_dir = args.data_dir or data_cfg.get("data_dir", "./data")
    pairs = [args.pair] if args.pair else data_cfg.get("pairs", DEFAULT_PAIRS)

    print(f"Backfilling {len(pairs)} pairs, {days} days, {interval}m bars")
    print(f"Data directory: {data_dir}\n")

    for pair in pairs:
        try:
            df = backfill_pair(pair, days=days, interval=interval, data_dir=data_dir)
            print(f"  {pair}: {len(df)} bars total\n")
        except Exception as e:
            print(f"  {pair}: ERROR - {e}\n")


if __name__ == "__main__":
    main()
