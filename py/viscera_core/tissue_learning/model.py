"""A real masked RGB encoder and periodic coordinate decoder; no PBR supervision."""

from __future__ import annotations

import math

import torch
from torch import nn
from torch.nn import functional as F

from .config import ExperimentConfig


class FixedGridMean4(nn.Module):
    """Adaptive 4x4 pooling on the supported power-of-two encoder grids.

    For grids >=4 each output is one nonoverlapping block mean. For grids 1/2,
    adaptive pooling repeats individual cells exactly. These tensor operations
    avoid CUDA AdaptiveAvgPool2d backward, which PyTorch2.8 rejects when strict
    deterministic algorithms are enabled. No learned parameters/state are added.
    """

    def forward(self, value: torch.Tensor) -> torch.Tensor:
        if value.ndim != 4 or value.shape[-2] != value.shape[-1] or value.shape[-1] not in (1, 2, 4, 8, 16, 32):
            raise ValueError("pool requires a supported square power-of-two encoder grid")
        batch, channels, size, _ = value.shape
        if size < 4:
            repeat = 4 // size
            return value.repeat_interleave(repeat, dim=2).repeat_interleave(repeat, dim=3)
        block = size // 4
        return value.reshape(batch, channels, 4, block, 4, block).mean(dim=(3, 5))


class PeriodicDecoder(nn.Module):
    def __init__(self, config: ExperimentConfig, conditions: int):
        super().__init__()
        self.frequencies = tuple(config.frequencies)
        widths = [config.latent_dim + conditions + 4 * len(self.frequencies),
                  config.hidden_width, config.hidden_width, config.hidden_width, 3]
        self.layers = nn.ModuleList(nn.Linear(a, b) for a, b in zip(widths, widths[1:]))

    def forward(self, latent: torch.Tensor, condition: torch.Tensor, uv: torch.Tensor) -> torch.Tensor:
        # uv[B,N,2], latent[B,Z], condition[B,K]; features are frequency-major.
        features = torch.stack([value for f in self.frequencies for value in (
            torch.sin(2 * math.pi * f * uv[..., 0]), torch.cos(2 * math.pi * f * uv[..., 0]),
            torch.sin(2 * math.pi * f * uv[..., 1]), torch.cos(2 * math.pi * f * uv[..., 1]))], -1)
        count = uv.shape[1]
        value = torch.cat((latent[:, None, :].expand(-1, count, -1),
                           condition[:, None, :].expand(-1, count, -1), features), -1)
        for layer in self.layers[:-1]:
            value = F.silu(layer(value))
        return torch.sigmoid(self.layers[-1](value))


class TissueAppearanceVAE(nn.Module):
    def __init__(self, config: ExperimentConfig, conditions: int):
        super().__init__()
        self.config, self.condition_count = config, conditions
        widths = (4, 16, 32, 64, 64)
        blocks = []
        for a, b in zip(widths, widths[1:]):
            blocks.extend([nn.Conv2d(a, b, 3, stride=2, padding=1), nn.SiLU()])
        self.encoder = nn.Sequential(*blocks, FixedGridMean4(), nn.Flatten())
        self.posterior = nn.Linear(64 * 4 * 4 + conditions, 2 * config.latent_dim)
        self.decoder = PeriodicDecoder(config, conditions)

    def encode(self, rgb: torch.Tensor, mask: torch.Tensor,
               condition: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        # Invalid RGB is replaced before the encoder, not merely hidden in loss.
        encoded = self.encoder(torch.cat((rgb * mask + .5 * (1 - mask), mask), 1))
        mu, logvar = self.posterior(torch.cat((encoded, condition), 1)).chunk(2, -1)
        return mu, logvar.clamp(-8, 6)

    def forward(self, rgb: torch.Tensor, mask: torch.Tensor, condition: torch.Tensor,
                *, sample: bool = True) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        mu, logvar = self.encode(rgb, mask, condition)
        z = mu + torch.exp(.5 * logvar) * torch.randn_like(mu) if sample else mu
        size = rgb.shape[-1]
        coords = (torch.arange(size, device=rgb.device, dtype=torch.float32) + .5) / size
        v, u = torch.meshgrid(coords, coords, indexing="ij")
        uv = torch.stack((u, v), -1).reshape(1, -1, 2).expand(rgb.shape[0], -1, -1)
        result = self.decoder(z, condition, uv).transpose(1, 2).reshape_as(rgb)
        return result, mu, logvar


def objective(prediction: torch.Tensor, target: torch.Tensor, mask: torch.Tensor,
              mu: torch.Tensor, logvar: torch.Tensor, config: ExperimentConfig) -> dict[str, torch.Tensor]:
    if prediction.shape != target.shape or mask.shape != (target.shape[0], 1, *target.shape[2:]):
        raise ValueError("RGB/mask tensor dimensions do not match")
    if not all(torch.isfinite(value).all() for value in (prediction, target, mask, mu, logvar)):
        raise ValueError("nonfinite training tensor")
    if mask.min() < 0 or mask.max() > 1 or (mask.sum((1, 2, 3)) <= 0).any():
        raise ValueError("invalid or empty training mask")
    denominator = 3 * mask.sum((1, 2, 3))
    reconstruction = (((prediction.float() - target.float()).square() * mask).sum((1, 2, 3))
                      / denominator).mean()
    gradients = []
    for axis in (2, 3):
        left = [slice(None)] * 4
        right = [slice(None)] * 4
        left[axis], right[axis] = slice(1, None), slice(None, -1)
        left, right = tuple(left), tuple(right)
        valid = mask[left] * mask[right]
        error = ((prediction[left].float() - prediction[right].float())
                 - (target[left].float() - target[right].float())).square()
        gradients.append(((error * valid).sum((1, 2, 3))
                          / (3 * valid.sum((1, 2, 3))).clamp_min(1)).mean())
    gradient = sum(gradients) / 2
    kl = -.5 * (1 + logvar.float() - mu.float().square() - logvar.float().exp()).mean()
    return {"loss": reconstruction + config.gradient_weight * gradient + config.beta_kl * kl,
            "masked_mse": reconstruction, "valid_neighbor_mse": gradient, "kl": kl}
