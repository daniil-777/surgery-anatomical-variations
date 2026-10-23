"""Directional periodic CVAE plus a training-only, mask-matched patch critic."""

from __future__ import annotations

import math

import torch
from torch import nn
from torch.nn import functional as F

from viscera_core.tissue_learning.model import FixedGridMean4

from .config import DetailConfig


class DirectionalDecoder(nn.Module):
    def __init__(self, config: DetailConfig, conditions: int):
        super().__init__()
        self.vectors = config.fourier_vectors
        widths = [config.latent_dim + conditions + 2 * len(self.vectors),
                  config.hidden_width, config.hidden_width, config.hidden_width, 3]
        self.layers = nn.ModuleList(nn.Linear(a, b) for a, b in zip(widths, widths[1:]))

    def forward(self, latent, condition, uv):
        features = []
        for kx, ky in self.vectors:
            angle = (kx * uv[..., 0] + ky * uv[..., 1]) * (2 * math.pi)
            features.extend((torch.sin(angle), torch.cos(angle)))
        count = uv.shape[1]
        value = torch.cat((latent[:, None, :].expand(-1, count, -1),
                           condition[:, None, :].expand(-1, count, -1),
                           torch.stack(features, -1)), -1)
        for layer in self.layers[:-1]:
            value = F.silu(layer(value))
        return torch.sigmoid(self.layers[-1](value))


class DetailVAE(nn.Module):
    def __init__(self, config: DetailConfig, conditions: int):
        super().__init__()
        self.config, self.condition_count = config, conditions
        widths = (4, 32, 64, 96, 96)
        blocks = []
        for a, b in zip(widths, widths[1:]):
            blocks.extend((nn.Conv2d(a, b, 3, stride=2, padding=1), nn.SiLU()))
        self.encoder = nn.Sequential(*blocks, FixedGridMean4(), nn.Flatten())
        self.posterior = nn.Linear(96 * 4 * 4 + conditions, config.latent_dim * 2)
        self.decoder = DirectionalDecoder(config, conditions)

    def encode(self, rgb, mask, condition):
        hidden = self.encoder(torch.cat((rgb * mask + .5 * (1 - mask), mask), 1))
        mu, logvar = self.posterior(torch.cat((hidden, condition), 1)).chunk(2, -1)
        return mu, logvar.clamp(-8, 6)

    def forward(self, rgb, mask, condition, *, sample=True):
        mu, logvar = self.encode(rgb, mask, condition)
        latent = mu + torch.exp(.5 * logvar) * torch.randn_like(mu) if sample else mu
        prediction = self.decode_patch(latent, condition, rgb.shape[-1])
        return prediction, mu, logvar

    def decode_patch(self, latent, condition, size=128):
        coords = (torch.arange(size, dtype=torch.float32, device=latent.device) + .5) / size
        v, u = torch.meshgrid(coords, coords, indexing="ij")
        uv = torch.stack((u, v), -1).reshape(1, -1, 2).expand(latent.shape[0], -1, -1)
        return self.decoder(latent, condition, uv).transpose(1, 2).reshape(-1, 3, size, size)


class MaskedPatchCritic(nn.Module):
    """Four 3x3 convolutions give 23px receptive fields at output stride4.

    The same binary mask and0.5 invalid fill are used for real/posterior/prior.
    Scoring weights measure actual receptive-field coverage, including borders.
    No generated mask, pretrained network, BatchNorm or running statistics.
    """

    def __init__(self, conditions: int, width: int = 32):
        super().__init__()
        channels = (4 + conditions, width, width * 2, width * 2, 1)
        self.layers = nn.ModuleList(nn.utils.parametrizations.spectral_norm(
            nn.Conv2d(a, b, 3, stride=stride, padding=1))
            for a, b, stride in zip(channels, channels[1:], (2, 2, 1, 1)))

    def forward(self, rgb, mask, condition):
        code = condition[:, :, None, None].expand(-1, -1, *rgb.shape[-2:])
        value = torch.cat((rgb * mask + .5 * (1 - mask), mask, code), 1)
        features = []
        for layer in self.layers[:-1]:
            value = F.leaky_relu(layer(value), .2)
            features.append(value)
        return self.layers[-1](value), features


def critic_weights(mask, minimum_coverage=.75):
    coverage = F.avg_pool2d(mask.float(), kernel_size=23, stride=4, padding=11,
                          count_include_pad=True)
    return coverage * (coverage >= minimum_coverage)


def weighted_scores(value, weight):
    if value.shape != weight.shape or (weight.sum((1, 2, 3)) <= 0).any():
        raise ValueError("each native crop needs a valid critic receptive field")
    return ((value.float() * weight).sum((1, 2, 3)) / weight.sum((1, 2, 3))).mean()


def critic_hinge(real_scores, posterior_scores, prior_scores, weight):
    return (weighted_scores(F.relu(1 - real_scores), weight)
            + .5 * weighted_scores(F.relu(1 + posterior_scores), weight)
            + .5 * weighted_scores(F.relu(1 + prior_scores), weight))


def masked_feature_matching(predicted, reference, mask):
    # The real branch is detached; paired mask/fill is identical. Mask weights
    # exclude invalid features instead of rewarding the model for mask interiors.
    losses = []
    for generated, target in zip(predicted, reference, strict=True):
        weight = F.interpolate(mask.float(), size=generated.shape[-2:], mode="nearest")
        losses.append(((generated.float() - target.detach().float()).abs() * weight).sum()
                      / (generated.shape[1] * weight.sum()).clamp_min(1))
    return sum(losses) / len(losses)
