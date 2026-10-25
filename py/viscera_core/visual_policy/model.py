"""Pinned SmolVLA with low-rank action-expert adaptation and five skill actions.

This is a visual skill selector, not a continuous instrument-motion policy.
All base checkpoint tensors are loaded strictly before adapters are installed.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import numpy as np
import torch
from lerobot.configs.types import FeatureType, PolicyFeature
from lerobot.policies.smolvla.configuration_smolvla import SmolVLAConfig
from lerobot.policies.smolvla.modeling_smolvla import SmolVLAPolicy
from safetensors.torch import load_file, save_file
from torch import nn

BASE_REVISION = "5e8d12a6e2975b0e5e5fce7c8caf47c371d257b6"
VLM_REVISION = "7b375e1b73b11138ff12fe22c8f2822d8fe03467"


class LowRankLinear(nn.Module):
    def __init__(self, base: nn.Linear, rank: int = 8):
        super().__init__()
        self.base = base
        self.down = nn.Linear(base.in_features, rank, bias=False)
        self.up = nn.Linear(rank, base.out_features, bias=False)
        nn.init.normal_(self.down.weight, std=0.02)
        nn.init.zeros_(self.up.weight)

    @property
    def weight(self):
        return self.base.weight

    def forward(self, value):
        return self.base(value) + 2 * self.up(self.down(value))


def build_policy(root: Path, device: str, adapter: Path | None = None):
    config = SmolVLAConfig(
        device=device,
        vlm_model_name=str(root / "vlm"),
        load_vlm_weights=False,
        chunk_size=1,
        n_action_steps=1,
        num_steps=5,
        resize_imgs_with_padding=(256, 256),
        input_features={
            "observation.state": PolicyFeature(type=FeatureType.STATE, shape=(16,)),
            "observation.images.camera1": PolicyFeature(
                type=FeatureType.VISUAL, shape=(3, 256, 256)
            ),
        },
        output_features={"action": PolicyFeature(type=FeatureType.ACTION, shape=(5,))},
    )
    policy = SmolVLAPolicy(config)
    policy.load_state_dict(load_file(str(root / "base/model.safetensors")), strict=True)
    policy.requires_grad_(False)
    for layer in policy.model.vlm_with_expert.lm_expert.layers:
        for name in ("q_proj", "v_proj"):
            original = getattr(layer.self_attn, name)
            setattr(layer.self_attn, name, LowRankLinear(original))
    for name in (
        "state_proj",
        "action_in_proj",
        "action_out_proj",
        "action_time_mlp_in",
        "action_time_mlp_out",
    ):
        getattr(policy.model, name).requires_grad_(True)
    if adapter is not None:
        weights = load_file(str(adapter))
        expected = {name for name, param in policy.named_parameters() if param.requires_grad}
        if set(weights) != expected:
            raise ValueError("Adapter tensor contract mismatch")
        policy.load_state_dict(weights, strict=False)
    return policy.to(device)


def make_batch(policy, observations: list[dict], device: str):
    tokenizer = policy.model.vlm_with_expert.processor.tokenizer
    text = tokenizer(
        [o["instruction"] for o in observations],
        padding="max_length",
        max_length=48,
        truncation=True,
        return_tensors="pt",
    )
    images = np.stack(
        [np.asarray(o["image"], dtype=np.float32).transpose(2, 0, 1) / 255 for o in observations]
    )
    return {
        "observation.state": torch.tensor(
            [o["state"] for o in observations], dtype=torch.float32, device=device
        ),
        "observation.images.camera1": torch.tensor(images, device=device),
        "observation.language.tokens": text["input_ids"].to(device),
        "observation.language.attention_mask": text["attention_mask"].to(device).bool(),
    }


@torch.inference_mode()
def predict(policy, batch):
    # Fixed initial noise makes repeated observations reproducible. Evaluation
    # uses this exact five-step sampler, not a training-loss proxy.
    policy.eval()
    noise = torch.zeros(
        len(batch["observation.state"]), 1, 32, device=batch["observation.state"].device
    )
    return policy.predict_action_chunk(batch, noise=noise)[:, 0, :5].cpu().tolist()


def save_adapter(policy, path: Path):
    save_file(
        {
            name: param.detach().cpu().contiguous()
            for name, param in policy.named_parameters()
            if param.requires_grad
        },
        str(path),
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
