"""Trading-specific evaluation metrics for model validation."""

import numpy as np
import torch


def direction_accuracy(pred_logits: np.ndarray, true_labels: np.ndarray) -> float:
    """Accuracy of direction prediction (down/flat/up)."""
    pred = pred_logits.argmax(axis=-1)
    return (pred == true_labels).mean()


def direction_accuracy_by_class(
    pred_logits: np.ndarray, true_labels: np.ndarray
) -> dict[str, float]:
    """Per-class accuracy for direction prediction."""
    pred = pred_logits.argmax(axis=-1)
    labels = {0: "down", 1: "flat", 2: "up"}
    result = {}
    for cls, name in labels.items():
        mask = true_labels == cls
        if mask.sum() > 0:
            result[name] = (pred[mask] == cls).mean()
        else:
            result[name] = float("nan")
    return result


def profitable_direction_accuracy(
    pred_logits: np.ndarray, true_returns: np.ndarray
) -> float:
    """Accuracy of direction prediction weighted by actual return magnitude.

    Measures whether correct predictions coincide with larger moves.
    """
    pred = pred_logits.argmax(axis=-1)
    # Map predictions to expected sign: 0=down(-1), 1=flat(0), 2=up(+1)
    pred_sign = pred.astype(float) - 1.0
    alignment = pred_sign * true_returns
    return (alignment > 0).mean()


def simulated_sharpe(
    pred_logits: np.ndarray, true_returns: np.ndarray,
    annual_factor: float = np.sqrt(252 * 24 / 3)  # 3-hour bars per year
) -> float:
    """Sharpe ratio from a simulated strategy that follows direction predictions.

    Strategy: go long on up, short on down, flat on flat.
    """
    pred = pred_logits.argmax(axis=-1)
    positions = pred.astype(float) - 1.0  # -1, 0, +1
    pnl = positions * true_returns

    if pnl.std() < 1e-10:
        return 0.0
    return float((pnl.mean() / pnl.std()) * annual_factor)


def max_drawdown(returns: np.ndarray) -> float:
    """Maximum drawdown from a return series."""
    cumulative = np.cumprod(1 + returns)
    peak = np.maximum.accumulate(cumulative)
    drawdown = (cumulative - peak) / peak
    return float(drawdown.min()) if len(drawdown) > 0 else 0.0


def return_mae(pred_returns: np.ndarray, true_returns: np.ndarray) -> float:
    """Mean absolute error for return predictions."""
    return float(np.abs(pred_returns - true_returns).mean())


def return_correlation(pred_returns: np.ndarray, true_returns: np.ndarray) -> float:
    """Pearson correlation between predicted and actual returns."""
    if pred_returns.std() < 1e-10 or true_returns.std() < 1e-10:
        return 0.0
    return float(np.corrcoef(pred_returns, true_returns)[0, 1])


def compute_all_metrics(
    predictions: dict[str, np.ndarray], targets: dict[str, np.ndarray]
) -> dict[str, float]:
    """Compute all evaluation metrics from model predictions and targets.

    Args:
        predictions: dict with direction_logits (N,3), returns (N,3), confidence (N,1)
        targets: dict with direction (N,), return_6 (N,), return_12 (N,), return_36 (N,)

    Returns:
        dict of metric_name -> value
    """
    metrics = {}

    dir_logits = predictions["direction_logits"]
    dir_true = targets["direction"]

    # Direction metrics
    metrics["direction_accuracy"] = direction_accuracy(dir_logits, dir_true)
    per_class = direction_accuracy_by_class(dir_logits, dir_true)
    for cls, acc in per_class.items():
        metrics[f"accuracy_{cls}"] = acc

    # Return prediction metrics at each horizon
    horizon_names = ["30m", "1h", "3h"]
    target_keys = ["return_6", "return_12", "return_36"]
    pred_returns = predictions["returns"]

    for i, (name, tkey) in enumerate(zip(horizon_names, target_keys)):
        pred_r = pred_returns[:, i]
        true_r = targets[tkey]
        metrics[f"mae_{name}"] = return_mae(pred_r, true_r)
        metrics[f"corr_{name}"] = return_correlation(pred_r, true_r)

    # Trading simulation metrics (using 3h horizon)
    true_3h = targets["return_36"]
    metrics["profitable_dir_acc"] = profitable_direction_accuracy(dir_logits, true_3h)
    metrics["sharpe"] = simulated_sharpe(dir_logits, true_3h)

    # Strategy PnL
    positions = dir_logits.argmax(axis=-1).astype(float) - 1.0
    pnl = positions * true_3h
    metrics["strategy_return"] = float(pnl.sum())
    metrics["max_drawdown"] = max_drawdown(pnl)
    metrics["win_rate"] = float((pnl > 0).sum() / max(1, (pnl != 0).sum()))

    # Confidence calibration
    conf = predictions["confidence"].squeeze(-1)
    pred_correct = (dir_logits.argmax(axis=-1) == dir_true).astype(float)
    metrics["confidence_corr"] = return_correlation(conf, pred_correct)
    metrics["mean_confidence"] = float(conf.mean())

    return metrics


def collect_predictions(
    model, dataloader, device: torch.device
) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray]]:
    """Run model on a dataloader and collect all predictions/targets."""
    model.eval()
    all_preds = {"direction_logits": [], "returns": [], "confidence": []}
    all_targets = {"direction": [], "return_6": [], "return_12": [], "return_36": []}

    with torch.no_grad():
        for features, targets in dataloader:
            features = features.to(device)
            out = model(features)

            all_preds["direction_logits"].append(out["direction_logits"].cpu().numpy())
            all_preds["returns"].append(out["returns"].cpu().numpy())
            all_preds["confidence"].append(out["confidence"].cpu().numpy())

            all_targets["direction"].append(targets["direction"].numpy())
            all_targets["return_6"].append(targets["return_6"].numpy())
            all_targets["return_12"].append(targets["return_12"].numpy())
            all_targets["return_36"].append(targets["return_36"].numpy())

    preds = {k: np.concatenate(v) for k, v in all_preds.items()}
    tgts = {k: np.concatenate(v) for k, v in all_targets.items()}
    return preds, tgts
