"""TradingTransformer: Multi-task Transformer for intraday crypto prediction.

Architecture:
  Input (batch, 120, 40)
    -> Linear projection (40 -> d_model)
    -> Learnable positional encoding
    -> TransformerEncoder (4 layers, 8 heads)
    -> Attention pooling -> (batch, d_model)
    -> Shared MLP (d_model -> d_model//2)
    |-> DirectionHead -> [down, flat, up]
    |-> ReturnHead -> [return_30m, return_1hr, return_3hr]
    |-> ConfidenceHead -> [0, 1]
"""

import math
import torch
import torch.nn as nn
import torch.nn.functional as F


class LearnablePositionalEncoding(nn.Module):
    """Learnable positional encoding for sequence positions."""

    def __init__(self, max_len: int, d_model: int, dropout: float = 0.1):
        super().__init__()
        self.pos_embedding = nn.Parameter(torch.randn(1, max_len, d_model) * 0.02)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (batch, seq_len, d_model)
        x = x + self.pos_embedding[:, :x.size(1)]
        return self.dropout(x)


class AttentionPooling(nn.Module):
    """Learned attention pooling over sequence dimension."""

    def __init__(self, d_model: int):
        super().__init__()
        self.attention = nn.Linear(d_model, 1)

    def forward(self, x: torch.Tensor, mask: torch.Tensor = None) -> torch.Tensor:
        # x: (batch, seq_len, d_model)
        scores = self.attention(x).squeeze(-1)  # (batch, seq_len)
        if mask is not None:
            scores = scores.masked_fill(mask == 0, float("-inf"))
        weights = F.softmax(scores, dim=-1)  # (batch, seq_len)
        pooled = torch.bmm(weights.unsqueeze(1), x).squeeze(1)  # (batch, d_model)
        return pooled


class TradingTransformer(nn.Module):
    """Multi-task Transformer for intraday crypto trading prediction.

    Outputs:
        direction_logits: (batch, 3) — down/flat/up classification
        returns: (batch, 3) — predicted forward returns at 30m, 1h, 3h
        confidence: (batch, 1) — model confidence in [0, 1]
    """

    def __init__(
        self,
        num_features: int = 40,
        d_model: int = 128,
        nhead: int = 8,
        num_layers: int = 4,
        dim_feedforward: int = 256,
        dropout: float = 0.1,
        max_seq_len: int = 120,
        num_directions: int = 3,
        num_return_horizons: int = 3,
    ):
        super().__init__()
        self.d_model = d_model

        # Input projection
        self.input_proj = nn.Sequential(
            nn.Linear(num_features, d_model),
            nn.LayerNorm(d_model),
            nn.GELU(),
        )

        # Positional encoding
        self.pos_encoder = LearnablePositionalEncoding(max_seq_len, d_model, dropout)

        # Transformer encoder
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=nhead,
            dim_feedforward=dim_feedforward,
            dropout=dropout,
            activation="gelu",
            batch_first=True,
            norm_first=True,  # Pre-norm for better training stability
        )
        self.encoder = nn.TransformerEncoder(
            encoder_layer, num_layers=num_layers
        )

        # Attention pooling
        self.pool = AttentionPooling(d_model)

        # Shared trunk
        hidden = d_model // 2
        self.shared_mlp = nn.Sequential(
            nn.Linear(d_model, hidden),
            nn.GELU(),
            nn.Dropout(dropout),
        )

        # Task-specific heads
        self.direction_head = nn.Linear(hidden, num_directions)
        self.return_head = nn.Linear(hidden, num_return_horizons)
        self.confidence_head = nn.Sequential(
            nn.Linear(hidden, 1),
            nn.Sigmoid(),
        )

        self._init_weights()

    def _init_weights(self):
        """Xavier/Kaiming initialization for stable training."""
        for name, p in self.named_parameters():
            if "pos_embedding" in name:
                continue  # Already initialized
            if p.dim() > 1:
                nn.init.xavier_uniform_(p)
            elif "bias" in name:
                nn.init.zeros_(p)

    def forward(
        self, x: torch.Tensor, mask: torch.Tensor = None
    ) -> dict[str, torch.Tensor]:
        """
        Args:
            x: (batch, seq_len, num_features) input features
            mask: (batch, seq_len) optional padding mask (1=valid, 0=pad)

        Returns:
            dict with keys: direction_logits, returns, confidence
        """
        # Project input features to model dimension
        h = self.input_proj(x)  # (batch, seq_len, d_model)

        # Add positional encoding
        h = self.pos_encoder(h)

        # Create src_key_padding_mask for transformer (True = ignore)
        padding_mask = None
        if mask is not None:
            padding_mask = mask == 0

        # Transformer encoding
        h = self.encoder(h, src_key_padding_mask=padding_mask)

        # Pool over sequence
        pooled = self.pool(h, mask)  # (batch, d_model)

        # Shared MLP
        shared = self.shared_mlp(pooled)  # (batch, hidden)

        # Task heads
        direction_logits = self.direction_head(shared)  # (batch, 3)
        returns = self.return_head(shared)  # (batch, 3)
        confidence = self.confidence_head(shared)  # (batch, 1)

        return {
            "direction_logits": direction_logits,
            "returns": returns,
            "confidence": confidence,
        }

    def predict(self, x: torch.Tensor) -> dict[str, torch.Tensor]:
        """Convenience method for inference (adds softmax to direction)."""
        self.eval()
        with torch.no_grad():
            out = self.forward(x)
            out["direction_probs"] = F.softmax(out["direction_logits"], dim=-1)
        return out


class MultiTaskLoss(nn.Module):
    """Weighted multi-task loss for TradingTransformer.

    L = w_dir * CrossEntropy(direction)
      + w_r30m * Huber(return_30m)
      + w_r1h  * Huber(return_1h)
      + w_r3h  * Huber(return_3h)
      + w_conf * BCE(confidence)
    """

    def __init__(
        self,
        direction_weight: float = 1.0,
        return_30m_weight: float = 0.5,
        return_1h_weight: float = 1.0,
        return_3h_weight: float = 1.5,
        confidence_weight: float = 0.3,
        direction_class_weights: torch.Tensor = None,
    ):
        super().__init__()
        self.w_dir = direction_weight
        self.w_r30m = return_30m_weight
        self.w_r1h = return_1h_weight
        self.w_r3h = return_3h_weight
        self.w_conf = confidence_weight

        self.ce = nn.CrossEntropyLoss(weight=direction_class_weights)
        self.huber = nn.HuberLoss(delta=0.01)  # Small delta for % returns
        self.bce = nn.BCELoss()

    def forward(
        self, predictions: dict[str, torch.Tensor], targets: dict[str, torch.Tensor]
    ) -> dict[str, torch.Tensor]:
        """
        Args:
            predictions: output of TradingTransformer.forward()
            targets: dict with keys: direction, return_6, return_12, return_36

        Returns:
            dict with 'total' and individual loss components
        """
        losses = {}

        # Direction classification
        losses["direction"] = self.ce(
            predictions["direction_logits"], targets["direction"]
        )

        # Return regression at each horizon
        pred_returns = predictions["returns"]  # (batch, 3)
        losses["return_30m"] = self.huber(pred_returns[:, 0], targets["return_6"])
        losses["return_1h"] = self.huber(pred_returns[:, 1], targets["return_12"])
        losses["return_3h"] = self.huber(pred_returns[:, 2], targets["return_36"])

        # Confidence: target = 1 if direction prediction is correct, else 0
        with torch.no_grad():
            pred_dir = predictions["direction_logits"].argmax(dim=-1)
            correct = (pred_dir == targets["direction"]).float()
        losses["confidence"] = self.bce(
            predictions["confidence"].squeeze(-1), correct
        )

        # Weighted total
        losses["total"] = (
            self.w_dir * losses["direction"]
            + self.w_r30m * losses["return_30m"]
            + self.w_r1h * losses["return_1h"]
            + self.w_r3h * losses["return_3h"]
            + self.w_conf * losses["confidence"]
        )

        return losses


def build_model(config: dict) -> TradingTransformer:
    """Build TradingTransformer from config dict."""
    model_cfg = config.get("model", {})
    data_cfg = config.get("data", {})
    return TradingTransformer(
        num_features=model_cfg.get("num_features", 40),
        d_model=model_cfg.get("d_model", 128),
        nhead=model_cfg.get("nhead", 8),
        num_layers=model_cfg.get("num_layers", 4),
        dim_feedforward=model_cfg.get("dim_feedforward", 256),
        dropout=model_cfg.get("dropout", 0.1),
        max_seq_len=data_cfg.get("seq_len", 120),
    )


def build_loss(config: dict, class_weights: torch.Tensor = None) -> MultiTaskLoss:
    """Build MultiTaskLoss from config dict."""
    loss_cfg = config.get("loss_weights", {})
    return MultiTaskLoss(
        direction_weight=loss_cfg.get("direction", 1.0),
        return_30m_weight=loss_cfg.get("return_30m", 0.5),
        return_1h_weight=loss_cfg.get("return_1h", 1.0),
        return_3h_weight=loss_cfg.get("return_3h", 1.5),
        confidence_weight=loss_cfg.get("confidence", 0.3),
        direction_class_weights=class_weights,
    )
