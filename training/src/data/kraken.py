"""Kraken public OHLC data fetcher and backfill utility."""

import time
import httpx
import pandas as pd
import numpy as np
from pathlib import Path
from tqdm import tqdm

KRAKEN_BASE = "https://api.kraken.com"


def fetch_ohlc(pair: str, interval: int = 5, since: int = None) -> tuple[pd.DataFrame, int]:
    """Fetch OHLC data from Kraken public API.

    Returns (DataFrame, last_timestamp) where last_timestamp can be used for pagination.
    """
    params = {"pair": pair, "interval": interval}
    if since:
        params["since"] = since

    resp = httpx.get(f"{KRAKEN_BASE}/0/public/OHLC", params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()

    if data.get("error"):
        raise ValueError(f"Kraken API error: {data['error']}")

    result = data["result"]
    last = result.get("last", 0)

    # The result key is the pair name (may differ from input)
    pair_key = [k for k in result if k != "last"][0]
    rows = result[pair_key]

    if not rows:
        return pd.DataFrame(), last

    df = pd.DataFrame(rows, columns=[
        "timestamp", "open", "high", "low", "close", "vwap", "volume", "count"
    ])
    df["timestamp"] = pd.to_datetime(df["timestamp"].astype(int), unit="s")
    for col in ["open", "high", "low", "close", "vwap", "volume"]:
        df[col] = df[col].astype(float)
    df["count"] = df["count"].astype(int)
    df = df.set_index("timestamp").sort_index()

    return df, int(last)


def backfill_pair(pair: str, days: int = 90, interval: int = 5,
                  data_dir: str = "./data") -> pd.DataFrame:
    """Backfill historical OHLC data by paginating the Kraken API.

    Stores result as a parquet file and returns the full DataFrame.
    """
    data_dir = Path(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    parquet_path = data_dir / f"{pair}_{interval}m.parquet"

    # Load existing data if available
    existing = None
    if parquet_path.exists():
        existing = pd.read_parquet(parquet_path)
        print(f"  Loaded {len(existing)} existing bars for {pair}")

    target_start = int(time.time()) - (days * 86400)
    since = target_start
    all_frames = []
    bars_per_request = 720
    expected_requests = max(1, (days * 24 * 60 // interval) // bars_per_request)

    print(f"Backfilling {pair} ({days} days, {interval}m bars)...")
    pbar = tqdm(total=expected_requests, desc=pair)

    while True:
        try:
            df, last = fetch_ohlc(pair, interval=interval, since=since)
        except Exception as e:
            print(f"  Error fetching {pair}: {e}")
            time.sleep(2)
            continue

        if df.empty or last <= since:
            break

        all_frames.append(df)
        since = last
        pbar.update(1)
        time.sleep(1.1)  # Rate limit: ~1 req/sec for public endpoints

    pbar.close()

    if not all_frames:
        if existing is not None:
            return existing
        return pd.DataFrame()

    new_data = pd.concat(all_frames)
    new_data = new_data[~new_data.index.duplicated(keep="last")]

    if existing is not None:
        combined = pd.concat([existing, new_data])
        combined = combined[~combined.index.duplicated(keep="last")]
        combined = combined.sort_index()
    else:
        combined = new_data.sort_index()

    combined.to_parquet(parquet_path)
    print(f"  Saved {len(combined)} bars to {parquet_path}")
    return combined


def load_pair(pair: str, interval: int = 5, data_dir: str = "./data") -> pd.DataFrame:
    """Load cached parquet data for a pair."""
    path = Path(data_dir) / f"{pair}_{interval}m.parquet"
    if not path.exists():
        raise FileNotFoundError(f"No data for {pair}. Run backfill first.")
    return pd.read_parquet(path)


DEFAULT_PAIRS = ["XXBTZUSD", "XETHZUSD", "SOLUSD", "XRPUSD", "ADAUSD"]
