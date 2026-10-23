"""Mask-safe normalized detail objectives; unpaired priors match statistics only."""

import torch
from torch.nn import functional as F


def charbonnier(value, epsilon):
    return (value.square() + epsilon**2).sqrt() - epsilon


def neighbor_charbonnier(prediction, target, mask, scales, epsilon=0.01):
    """Both endpoints must be valid; detached train-only per-RGB scales."""
    values = []
    for dim in (-2, -1):
        a = [slice(None)] * 4
        b = [slice(None)] * 4
        a[dim], b[dim] = slice(1, None), slice(None, -1)
        a, b = tuple(a), tuple(b)
        valid = mask[a] * mask[b]
        error = (
            (prediction[a].float() - prediction[b].float())
            - (target[a].float() - target[b].float())
        ) / scales.detach()[:, :, None, None]
        term = charbonnier(error, epsilon)
        count = 3 * valid.sum((1, 2, 3))
        values.append((term * valid).sum((1, 2, 3)) / count.clamp_min(1))
    return torch.stack(values).mean()


def native_statistics(rgb, mask, kernels=(3, 5, 9)):
    """No neutral fill and no padded/invalid neighborhoods enter residuals.

    Per-channel residual RMS is unpaired. It cannot establish coherent anatomy;
    noise and halos must additionally fail the image-review gate.
    """
    rgb, mask = rgb.float(), mask.float()
    count = mask.sum((2, 3)).clamp_min(1)
    mean = (rgb * mask).sum((2, 3)) / count
    variance = ((rgb - mean[:, :, None, None]).square() * mask).sum((2, 3)) / count
    std = (variance + 1e-12).sqrt()
    lum = rgb.mean(1, keepdim=True)
    tails = torch.cat((torch.sigmoid((0.05 - lum) / 0.02), torch.sigmoid((lum - 0.95) / 0.02)), 1)
    tails = (tails * mask).sum((2, 3)) / count
    residual_rms, support = [], []
    for kernel in kernels:
        radius = kernel // 2
        valid = F.avg_pool2d(mask, kernel, stride=1) >= 1 - 1e-7
        center = rgb[:, :, radius:-radius, radius:-radius]
        residual = center - F.avg_pool2d(rgb, kernel, stride=1)
        count_window = valid.sum((2, 3))
        energy = (residual.square() * valid).sum((2, 3)) / count_window.clamp_min(1)
        residual_rms.append((energy + 1e-12).sqrt())
        support.append(count_window[:, 0])
    return {
        "mean": mean,
        "std": std,
        "tails": tails,
        "frequency": torch.stack(residual_rms, 1),
        "support": torch.stack(support, 1),
    }


def prior_matching(prior, mask, condition_indices, reference, objective):
    """Match train-only condition targets, never unrelated source pixels."""
    statistics = native_statistics(prior, mask, objective.kernels)
    device = prior.device

    def tensor(key):
        return torch.as_tensor(reference[key], dtype=torch.float32, device=device)[
            condition_indices
        ].detach()

    target = tensor("frequency_rms")
    ratio_error = torch.log(
        (statistics["frequency"] + objective.scale_floor) / (target + objective.scale_floor)
    )
    usable = (statistics["support"] > 0)[:, :, None]
    frequency = (charbonnier(ratio_error, objective.charbonnier_epsilon) * usable).sum() / (
        3 * usable.sum()
    ).clamp_min(1)
    values = torch.cat((statistics["mean"], statistics["std"], statistics["tails"]), 1)
    lower, upper = tensor("palette_lower"), tensor("palette_upper")
    scale = (upper - lower).clamp_min(0.02)
    outside = (F.relu(lower - values) + F.relu(values - upper)) / scale
    palette = charbonnier(outside, objective.charbonnier_epsilon).mean()
    return frequency, palette, statistics
