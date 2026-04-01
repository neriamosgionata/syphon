"""Feature engineering for 5-minute OHLCV bars.

Computes ~40 features per bar:
- Price (5): normalized OHLC + spread
- Volume (4): log volume, vwap, trade count, volume MA ratio
- Technical (12): RSI(14,7), MACD, Stochastic, Bollinger, ATR, ADX
- Moving Avg (4): price/EMA ratios, crossover
- Momentum (4): multi-horizon returns
- Volatility (4): realized, parkinson, garman-klass
- Microstructure (3): vwap deviation, volume imbalance, body ratio
- Temporal (4): hour/weekday cyclical encoding
"""

import numpy as np
import pandas as pd


# ─── Indicator helpers ───────────────────────────────────────

def _ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def _sma(series: pd.Series, window: int) -> pd.Series:
    return series.rolling(window, min_periods=1).mean()


def _rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = (-delta).clip(lower=0)
    avg_gain = gain.ewm(alpha=1/period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1/period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _macd(close: pd.Series, fast=12, slow=26, signal=9) -> pd.Series:
    ema_fast = _ema(close, fast)
    ema_slow = _ema(close, slow)
    macd_line = ema_fast - ema_slow
    signal_line = _ema(macd_line, signal)
    return (macd_line - signal_line) / close * 100  # Price-normalized histogram


def _stochastic(high: pd.Series, low: pd.Series, close: pd.Series,
                k_period=14, d_period=3) -> tuple[pd.Series, pd.Series]:
    lowest = low.rolling(k_period, min_periods=1).min()
    highest = high.rolling(k_period, min_periods=1).max()
    k = 100 * (close - lowest) / (highest - lowest).replace(0, np.nan)
    d = _sma(k, d_period)
    return k, d


def _bollinger(close: pd.Series, period=20, num_std=2) -> tuple[pd.Series, pd.Series]:
    middle = _sma(close, period)
    std = close.rolling(period, min_periods=1).std()
    upper = middle + num_std * std
    lower = middle - num_std * std
    width = (upper - lower) / middle.replace(0, np.nan)
    pct_b = (close - lower) / (upper - lower).replace(0, np.nan)
    return pct_b, width


def _atr(high: pd.Series, low: pd.Series, close: pd.Series, period=14) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs()
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1/period, adjust=False).mean()


def _adx(high: pd.Series, low: pd.Series, close: pd.Series, period=14
         ) -> tuple[pd.Series, pd.Series, pd.Series]:
    prev_high = high.shift(1)
    prev_low = low.shift(1)

    plus_dm = np.where((high - prev_high) > (prev_low - low),
                       np.maximum(high - prev_high, 0), 0)
    minus_dm = np.where((prev_low - low) > (high - prev_high),
                        np.maximum(prev_low - low, 0), 0)

    atr = _atr(high, low, close, period)
    plus_di = 100 * pd.Series(plus_dm, index=high.index).ewm(alpha=1/period, adjust=False).mean() / atr.replace(0, np.nan)
    minus_di = 100 * pd.Series(minus_dm, index=high.index).ewm(alpha=1/period, adjust=False).mean() / atr.replace(0, np.nan)

    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx = dx.ewm(alpha=1/period, adjust=False).mean()

    return adx, plus_di, minus_di


# ─── Main feature computation ───────────────────────────────

def compute_features(df: pd.DataFrame) -> pd.DataFrame:
    """Compute all features from a 5-min OHLCV DataFrame.

    Input must have columns: open, high, low, close, volume, vwap, count
    Index must be a DatetimeIndex.
    Returns a DataFrame with ~40 feature columns, same index.
    """
    o, h, l, c, v = df["open"], df["high"], df["low"], df["close"], df["volume"]
    vwap = df["vwap"] if "vwap" in df.columns else c
    count = df["count"].astype(float) if "count" in df.columns else pd.Series(0.0, index=df.index)

    feats = pd.DataFrame(index=df.index)

    # ── Price features (5) ──
    feats["ret_close"] = c.pct_change()
    feats["ret_open"] = o.pct_change()
    feats["ret_high"] = h.pct_change()
    feats["ret_low"] = l.pct_change()
    feats["spread"] = (h - l) / c.replace(0, np.nan)

    # ── Volume features (4) ──
    feats["log_volume"] = np.log1p(v)
    feats["vwap_norm"] = vwap / c.replace(0, np.nan) - 1
    feats["trade_count"] = np.log1p(count)
    vol_ma = _sma(v, 20)
    feats["volume_ma_ratio"] = v / vol_ma.replace(0, np.nan)

    # ── Technical indicators (12) ──
    feats["rsi_14"] = _rsi(c, 14) / 100  # Normalize to 0-1
    feats["rsi_7"] = _rsi(c, 7) / 100
    feats["macd_hist"] = _macd(c)
    stoch_k, stoch_d = _stochastic(h, l, c)
    feats["stoch_k"] = stoch_k / 100
    feats["stoch_d"] = stoch_d / 100
    bb_pctb, bb_width = _bollinger(c)
    feats["bb_pctb"] = bb_pctb
    feats["bb_width"] = bb_width
    feats["atr_14"] = _atr(h, l, c, 14) / c.replace(0, np.nan)  # ATR as % of price
    adx, plus_di, minus_di = _adx(h, l, c, 14)
    feats["adx"] = adx / 100
    feats["plus_di"] = plus_di / 100
    feats["minus_di"] = minus_di / 100

    # ── Moving average features (4) ──
    ema9 = _ema(c, 9)
    ema21 = _ema(c, 21)
    sma50 = _sma(c, 50)
    feats["price_ema9"] = c / ema9.replace(0, np.nan) - 1
    feats["price_ema21"] = c / ema21.replace(0, np.nan) - 1
    feats["price_sma50"] = c / sma50.replace(0, np.nan) - 1
    feats["ema_cross"] = (ema9 - ema21) / c.replace(0, np.nan)

    # ── Momentum features (4) ──
    feats["ret_30m"] = c.pct_change(6)    # 6 bars = 30 min
    feats["ret_1h"] = c.pct_change(12)    # 12 bars = 1 hour
    feats["ret_3h"] = c.pct_change(36)    # 36 bars = 3 hours
    feats["ret_6h"] = c.pct_change(72)    # 72 bars = 6 hours

    # ── Volatility features (4) ──
    log_ret = np.log(c / c.shift(1))
    feats["realized_vol_1h"] = log_ret.rolling(12).std() * np.sqrt(12 * 24)
    feats["realized_vol_3h"] = log_ret.rolling(36).std() * np.sqrt(12 * 24)
    # Parkinson volatility (uses high/low)
    feats["parkinson_vol"] = np.sqrt(
        (1 / (4 * np.log(2))) * (np.log(h / l.replace(0, np.nan)) ** 2)
    ).rolling(12).mean()
    # Garman-Klass volatility
    gk = 0.5 * np.log(h / l.replace(0, np.nan)) ** 2 - (2 * np.log(2) - 1) * np.log(c / o.replace(0, np.nan)) ** 2
    feats["garman_klass_vol"] = gk.rolling(12).mean()

    # ── Microstructure features (3) ──
    feats["vwap_deviation"] = (c - vwap) / c.replace(0, np.nan)
    # Volume imbalance: positive = more buying, negative = more selling
    direction = np.sign(c - o)
    feats["volume_imbalance"] = (direction * v).rolling(12).sum() / v.rolling(12).sum().replace(0, np.nan)
    feats["body_ratio"] = (c - o).abs() / (h - l).replace(0, np.nan)

    # ── Temporal features (4) ──
    hour = df.index.hour + df.index.minute / 60
    weekday = df.index.weekday
    feats["hour_sin"] = np.sin(2 * np.pi * hour / 24)
    feats["hour_cos"] = np.cos(2 * np.pi * hour / 24)
    feats["weekday_sin"] = np.sin(2 * np.pi * weekday / 7)
    feats["weekday_cos"] = np.cos(2 * np.pi * weekday / 7)

    return feats


def compute_targets(df: pd.DataFrame, horizons: list[int] = None,
                    direction_threshold: float = 0.003) -> pd.DataFrame:
    """Compute forward return targets.

    Args:
        df: OHLCV DataFrame with 'close' column
        horizons: list of bar counts [6, 12, 36] for 30min, 1hr, 3hr
        direction_threshold: % threshold for up/flat/down classification (0.3%)
    """
    if horizons is None:
        horizons = [6, 12, 36]

    c = df["close"]
    targets = pd.DataFrame(index=df.index)

    for h in horizons:
        fwd = c.shift(-h) / c - 1  # Forward return
        targets[f"return_{h}"] = fwd

    # Direction label based on longest horizon
    main_return = targets[f"return_{horizons[-1]}"]
    targets["direction"] = 1  # flat
    targets.loc[main_return > direction_threshold, "direction"] = 2   # up
    targets.loc[main_return < -direction_threshold, "direction"] = 0  # down

    return targets


FEATURE_COLUMNS = [
    # Price (5)
    "ret_close", "ret_open", "ret_high", "ret_low", "spread",
    # Volume (4)
    "log_volume", "vwap_norm", "trade_count", "volume_ma_ratio",
    # Technical (12)
    "rsi_14", "rsi_7", "macd_hist", "stoch_k", "stoch_d",
    "bb_pctb", "bb_width", "atr_14", "adx", "plus_di", "minus_di",
    # Moving Avg (4) — rsi_7 counted above, one extra slot
    "price_ema9", "price_ema21", "price_sma50", "ema_cross",
    # Momentum (4)
    "ret_30m", "ret_1h", "ret_3h", "ret_6h",
    # Volatility (4)
    "realized_vol_1h", "realized_vol_3h", "parkinson_vol", "garman_klass_vol",
    # Microstructure (3)
    "vwap_deviation", "volume_imbalance", "body_ratio",
    # Temporal (4)
    "hour_sin", "hour_cos", "weekday_sin", "weekday_cos",
]
