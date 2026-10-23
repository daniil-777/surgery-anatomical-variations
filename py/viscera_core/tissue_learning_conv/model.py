"""Spatial CVAE with resize convolutions; no position/Fourier features."""

from __future__ import annotations

import math

import torch
from torch import nn
from torch.nn import functional as F

from viscera_core.tissue_learning_detail.model import critic_weights as critic_weights
from viscera_core.tissue_learning_detail.model import weighted_scores

from .config import ConvConfig


def circular_pad1(value):
    # Explicit concatenation avoids relying on nondeterministic padding kernels.
    value = torch.cat((value[..., -1:], value, value[..., :1]), -1)
    return torch.cat((value[..., -1:, :], value, value[..., :1, :]), -2)


class SpatialDecoder(nn.Module):
    def __init__(self, config: ConvConfig, conditions: int):
        super().__init__()
        self.latent_channels = config.latent_channels
        widths = [config.latent_channels + conditions, config.decoder_channels[0]]
        for width in config.decoder_channels[1:]:
            widths.extend((width, width))
        widths.append(3)
        self.layers = nn.ModuleList(nn.Conv2d(a, b, 3) for a, b in zip(widths, widths[1:]))
        # Preserve an initial spatial signal through ten layers. PyTorch's
        # generic fan-in uniform defaults shrink this unnormalized SiLU stack.
        for layer in self.layers[:-1]:
            nn.init.kaiming_normal_(layer.weight, nonlinearity="relu")
            nn.init.zeros_(layer.bias)
        nn.init.xavier_normal_(self.layers[-1].weight, gain=0.5)
        nn.init.zeros_(self.layers[-1].bias)

    def forward(self, latent, condition):
        latent = latent.reshape(-1, self.latent_channels, 8, 8)
        code = condition[:, :, None, None].expand(-1, -1, 8, 8)
        value = torch.cat((latent, code), 1)
        for index, layer in enumerate(self.layers):
            if index in (1, 3, 5, 7):
                value = value.repeat_interleave(2, -2).repeat_interleave(2, -1)
            value = layer(circular_pad1(value))
            value = torch.sigmoid(value) if index == 9 else F.silu(value)
        return value


class ConvVAE(nn.Module):
    def __init__(self, config: ConvConfig, conditions: int):
        super().__init__()
        self.config, self.condition_count = config, conditions
        widths = (4, *config.encoder_channels)
        blocks = []
        for a, b in zip(widths, widths[1:]):
            blocks.extend((nn.Conv2d(a, b, 3, stride=2, padding=1), nn.SiLU()))
        self.encoder = nn.Sequential(*blocks)
        self.posterior = nn.Conv2d(widths[-1] + conditions, config.latent_channels * 2, 1)
        self.decoder = SpatialDecoder(config, conditions)

    def encode(self, rgb, mask, condition):
        hidden = self.encoder(torch.cat((rgb * mask + 0.5 * (1 - mask), mask), 1))
        code = condition[:, :, None, None].expand(-1, -1, 8, 8)
        mu, logvar = self.posterior(torch.cat((hidden, code), 1)).chunk(2, 1)
        return mu.flatten(1), logvar.clamp(-8, 6).flatten(1)

    def forward(self, rgb, mask, condition, *, sample=True):
        mu, logvar = self.encode(rgb, mask, condition)
        latent = mu + torch.exp(0.5 * logvar) * torch.randn_like(mu) if sample else mu
        return self.decode_patch(latent, condition), mu, logvar

    def decode_patch(self, latent, condition, size=128):
        if size != 128:
            raise ValueError("decoder learns native128 only; output resizing must be explicit")
        return self.decoder(latent, condition)


class ProjectionPatchCritic(nn.Module):
    """Condition projection on four SN convolutions, RF23/stride4 as prepared."""

    def __init__(self, conditions, width=32):
        super().__init__()
        widths = (4, width, width * 2, width * 2, width * 2)
        self.layers = nn.ModuleList(
            nn.utils.parametrizations.spectral_norm(nn.Conv2d(a, b, 3, stride=s, padding=1))
            for a, b, s in zip(widths, widths[1:], (2, 2, 1, 1))
        )
        self.score = nn.utils.parametrizations.spectral_norm(nn.Conv2d(width * 2, 1, 1))
        self.condition = nn.utils.parametrizations.spectral_norm(
            nn.Linear(conditions, width * 2, bias=False)
        )

    def forward(self, rgb, mask, condition):
        value = torch.cat((rgb * mask + 0.5 * (1 - mask), mask), 1)
        features = []
        for layer in self.layers:
            value = F.leaky_relu(layer(value), 0.2)
            features.append(value)
        code = self.condition(condition)[:, :, None, None]
        score = self.score(value) + (value * code).sum(1, keepdim=True) / math.sqrt(value.shape[1])
        return score, features


def critic_hinge(real, posterior, prior, weight):
    return (
        weighted_scores(F.relu(1 - real), weight)
        + 0.25 * weighted_scores(F.relu(1 + posterior), weight)
        + 0.75 * weighted_scores(F.relu(1 + prior), weight)
    )


def masked_feature_matching(predicted, reference, mask, minimum_coverage=0.75):
    losses = []
    for generated, target, (rf, stride) in zip(
        predicted, reference, ((3, 2), (7, 4), (15, 4), (23, 4)), strict=True
    ):
        coverage = F.avg_pool2d(mask.float(), rf, stride, rf // 2, count_include_pad=True)
        weight = coverage * (coverage >= minimum_coverage)
        if generated.shape[-2:] != weight.shape[-2:]:
            raise ValueError("feature receptive field alignment mismatch")
        difference = (generated.float() - target.detach().float()).abs()
        losses.append(
            (
                (difference * weight).sum((1, 2, 3))
                / (generated.shape[1] * weight.sum((1, 2, 3))).clamp_min(1)
            ).mean()
        )
    return sum(losses) / len(losses)
