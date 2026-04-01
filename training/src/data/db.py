"""MySQL database access for reading sentiment and ticker data."""

import mysql.connector
import pandas as pd

# Mapping from crypto symbols to ticker search terms
CRYPTO_SYMBOL_MAP = {
    "XXBTZUSD": ["BTC", "BITCOIN"],
    "XETHZUSD": ["ETH", "ETHEREUM"],
    "SOLUSD": ["SOL", "SOLANA"],
    "XRPUSD": ["XRP", "RIPPLE"],
    "ADAUSD": ["ADA", "CARDANO"],
    "DOTUSD": ["DOT", "POLKADOT"],
    "LINKUSD": ["LINK", "CHAINLINK"],
    "AVAXUSD": ["AVAX", "AVALANCHE"],
}


def get_connection(config: dict):
    return mysql.connector.connect(
        host=config.get("host", "127.0.0.1"),
        port=int(config.get("port", 3307)),
        user=config.get("user", "syphon"),
        password=config.get("password", "syphon_pass"),
        database=config.get("database", "syphon"),
    )


def load_sentiment(pair: str, config: dict, days: int = 90) -> pd.DataFrame:
    """Load sentiment analysis data for a crypto pair from MySQL.

    Maps Kraken pair names to ticker symbols in the analyses table.
    Returns DataFrame with: timestamp, sentiment_score, relevance, confidence
    """
    search_terms = CRYPTO_SYMBOL_MAP.get(pair, [pair[:3]])

    conn = get_connection(config)
    try:
        # Find ticker IDs matching the crypto symbol
        placeholders = ",".join(["%s"] * len(search_terms))
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT id FROM tickers WHERE symbol IN ({placeholders})",
            search_terms,
        )
        ticker_ids = [row[0] for row in cursor.fetchall()]
        cursor.close()

        if not ticker_ids:
            return pd.DataFrame()

        placeholders = ",".join(["%s"] * len(ticker_ids))
        query = f"""
            SELECT
                a.created_at as timestamp,
                a.sentiment_score,
                a.relevance_score,
                a.confidence
            FROM analyses a
            WHERE a.ticker_id IN ({placeholders})
              AND a.created_at >= DATE_SUB(NOW(), INTERVAL %s DAY)
            ORDER BY a.created_at
        """
        df = pd.read_sql(query, conn, params=[*ticker_ids, days])
        if not df.empty:
            df["timestamp"] = pd.to_datetime(df["timestamp"])
            df = df.set_index("timestamp")
        return df
    finally:
        conn.close()


def load_table_stats(config: dict) -> list[dict]:
    """Load table row counts and sizes for metrics dashboard."""
    conn = get_connection(config)
    try:
        df = pd.read_sql("SHOW TABLE STATUS", conn)
        tables = []
        for _, row in df.iterrows():
            size_mb = (float(row.get("Data_length", 0) or 0) +
                       float(row.get("Index_length", 0) or 0)) / (1024 * 1024)
            tables.append({
                "name": row["Name"],
                "rows": int(row.get("Rows", 0) or 0),
                "sizeMB": round(size_mb, 2),
            })
        return tables
    finally:
        conn.close()
