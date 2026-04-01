"""PyTorch Dataset for trading sequences with sliding windows."""

import numpy as np
import torch
from torch.utils.data import Dataset


class TradingDataset(Dataset):
    """Sliding-window dataset over feature matrices.

    Each sample is a (features_seq, targets) pair where:
    - features_seq: (seq_len, num_features) tensor of normalized features
    - targets: dict of tensors (direction, return_6, return_12, return_36)
    """

    def __init__(self, features: np.ndarray, targets: dict[str, np.ndarray],
                 seq_len: int = 120, stride: int = 1):
        """
        Args:
            features: (T, F) array of features
            targets: dict mapping target names to (T,) arrays
            seq_len: lookback window length
            stride: step between windows (1 = every bar, 6 = every 30min)
        """
        self.features = features
        self.targets = targets
        self.seq_len = seq_len
        self.stride = stride

        # Valid indices: need seq_len bars of history and target must exist
        self.valid_indices = []
        T = len(features)
        direction = targets.get("direction")
        for i in range(seq_len, T, stride):
            if direction is not None and np.isnan(direction[i]):
                continue
            # Check features aren't all NaN in the window
            window = features[i - seq_len:i]
            if np.isnan(window).all(axis=0).any():
                continue
            self.valid_indices.append(i)

    def __len__(self) -> int:
        return len(self.valid_indices)

    def __getitem__(self, idx: int) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
        i = self.valid_indices[idx]
        window = self.features[i - self.seq_len:i].copy()

        # Replace remaining NaNs with 0
        window = np.nan_to_num(window, nan=0.0)

        feat_tensor = torch.tensor(window, dtype=torch.float32)

        target_dict = {}
        for key, arr in self.targets.items():
            val = arr[i]
            if key == "direction":
                target_dict[key] = torch.tensor(int(val), dtype=torch.long)
            else:
                target_dict[key] = torch.tensor(
                    float(val) if not np.isnan(val) else 0.0,
                    dtype=torch.float32
                )

        return feat_tensor, target_dict


def build_dataset(features_df, targets_df, seq_len: int = 120,
                  stride: int = 1, normalize: bool = True):
    """Build a TradingDataset from feature and target DataFrames.

    Args:
        features_df: DataFrame of features (aligned index with targets_df)
        targets_df: DataFrame of targets
        seq_len: lookback window
        stride: step between samples
        normalize: whether to z-score normalize features

    Returns:
        (TradingDataset, scaler_params) where scaler_params is (mean, std) or None
    """
    feat_arr = features_df.values.astype(np.float32)
    scaler_params = None

    if normalize:
        mean = np.nanmean(feat_arr, axis=0)
        std = np.nanstd(feat_arr, axis=0)
        std[std < 1e-8] = 1.0  # Prevent division by zero
        feat_arr = (feat_arr - mean) / std
        scaler_params = (mean, std)

    target_dict = {}
    for col in targets_df.columns:
        target_dict[col] = targets_df[col].values.astype(np.float32)

    ds = TradingDataset(feat_arr, target_dict, seq_len=seq_len, stride=stride)
    return ds, scaler_params
