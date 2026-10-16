"""Boundary and prompt-geometry tests for the optional local SAM 2 adapter."""

import sys
from contextlib import nullcontext
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from services.api import reference_segmenter as segmenter


class Tensor:
    def __init__(self, data):
        self.data = np.asarray(data)

    def cpu(self):
        return self

    def detach(self):
        return self

    def numpy(self):
        return self.data

    def reshape(self, *shape):
        return Tensor(self.data.reshape(*shape))

    def __getitem__(self, item):
        result = self.data[item]
        return Tensor(result) if isinstance(result, np.ndarray) else result


class Inputs(dict):
    def to(self, device):
        return self


@pytest.fixture
def image():
    return Image.new("RGB", (100, 60), (140, 40, 30))


@pytest.fixture
def fake_backend(monkeypatch):
    calls = []
    output_mask = np.zeros((60, 100), dtype=bool)
    output_mask[10:50, 20:80] = True

    class Processor:
        def __call__(self, **kwargs):
            calls.append(kwargs)
            return Inputs(original_sizes=Tensor([[60, 100]]))

        def post_process_masks(self, masks, original_sizes):
            assert original_sizes.numpy().tolist() == [[60, 100]]
            return [Tensor(output_mask[None, None])]

    def model(**kwargs):
        assert kwargs["multimask_output"] is False
        return SimpleNamespace(pred_masks=Tensor([0]), iou_scores=Tensor([[[0.83]]]))

    backend = segmenter._Backend(
        Processor(), model, SimpleNamespace(inference_mode=nullcontext), "abc123", "cpu"
    )
    monkeypatch.setattr(segmenter, "_get_backend", lambda: backend)
    return calls, output_mask, backend


def test_prompt_geometry_and_labels_preserve_original_image(image, fake_backend):
    calls, expected, _ = fake_backend
    mask, metadata = segmenter.segment_sam2(
        image, [0.1, 0.2, 0.9, 0.8], [[0.5, 0.5], [1, 1]], [[0, 0]]
    )
    assert calls[0]["input_boxes"] == [[[10, 12, 90, 48]]]
    assert calls[0]["input_points"] == [[[[49.5, 29.5], [99, 59], [0, 0]]]]
    assert calls[0]["input_labels"] == [[[1, 1, 0]]]
    np.testing.assert_array_equal(mask, expected)
    assert mask.dtype == np.bool_
    assert metadata["semantic_identity"] == "user_assigned"
    assert metadata["review_required"] is True
    assert metadata["predicted_iou"] == 0.83
    assert metadata["checkpoint_sha256"] == "abc123"


def test_box_only_avoids_invalid_empty_point_tensor(image, fake_backend):
    calls, _, _ = fake_backend
    segmenter.segment_sam2(image, [0, 0, 1, 1], [], [])
    assert "input_points" not in calls[0]


@pytest.mark.parametrize(
    "box,foreground,background",
    [
        (None, [], [[0.5, 0.5]]),
        ([0.8, 0.2, 0.4, 0.9], [], []),
        ([0, 0, 1], [], []),
        ([0, 0, 1, float("nan")], [], []),
        (None, [[True, 0.5]], []),
        (None, [["0.5", 0.5]], []),
        (None, [[1.1, 0.5]], []),
        (None, [[0.5]], []),
        (None, [[0.5, 0.5]] * 65, []),
        (None, [[0.5, 0.5]] * 33, [[0.1, 0.1]] * 32),
    ],
)
def test_invalid_prompts_reject_before_model_load(monkeypatch, image, box, foreground, background):
    monkeypatch.setattr(segmenter, "_get_backend", lambda: pytest.fail("must not load model"))
    with pytest.raises(ValueError):
        segmenter.segment_sam2(image, box, foreground, background)


def test_rgb_required_before_model_load(image):
    with pytest.raises(ValueError, match="RGB"):
        segmenter.segment_sam2(image.convert("L"), [0, 0, 1, 1], [], [])


def test_unconfigured_and_missing_safe_weights_fail_closed(monkeypatch, tmp_path, image):
    monkeypatch.delenv("VISCERA_SAM2_MODEL", raising=False)
    monkeypatch.setattr(segmenter, "_DEFAULT_MODEL", tmp_path / "not-installed")
    assert segmenter.sam2_status()["configured"] is False
    with pytest.raises(segmenter.SegmenterUnavailable, match="not configured"):
        segmenter.segment_sam2(image, [0, 0, 1, 1], [], [])
    monkeypatch.setenv("VISCERA_SAM2_MODEL", str(tmp_path))
    # A pickle filename is never accepted in place of safetensors.
    (tmp_path / "pytorch_model.bin").write_bytes(b"pickle not read")
    with pytest.raises(segmenter.SegmenterUnavailable, match="model.safetensors"):
        segmenter.segment_sam2(image, [0, 0, 1, 1], [], [])


def test_installed_default_and_explicit_override(monkeypatch, tmp_path):
    monkeypatch.delenv("VISCERA_SAM2_MODEL", raising=False)
    monkeypatch.setattr(segmenter, "_DEFAULT_MODEL", tmp_path)
    assert segmenter._model_directory() == tmp_path
    override = tmp_path / "override"
    override.mkdir()
    monkeypatch.setenv("VISCERA_SAM2_MODEL", str(override))
    assert segmenter._model_directory() == override


def test_busy_request_rejects_without_waiting(image, fake_backend):
    assert segmenter._LOCK.acquire(blocking=False)
    try:
        with pytest.raises(segmenter.SegmenterUnavailable, match="busy"):
            segmenter.segment_sam2(image, [0, 0, 1, 1], [], [])
    finally:
        segmenter._LOCK.release()


def test_inference_error_releases_lock_and_does_not_fallback(image, fake_backend):
    _, _, backend = fake_backend
    backend.model = lambda **kwargs: (_ for _ in ()).throw(RuntimeError("test failure"))
    with pytest.raises(segmenter.SegmenterUnavailable, match="inference failed"):
        segmenter.segment_sam2(image, [0, 0, 1, 1], [], [])
    assert segmenter._LOCK.acquire(blocking=False)
    segmenter._LOCK.release()


def test_empty_mask_rejected(image, fake_backend):
    _, mask, _ = fake_backend
    mask[:] = False
    with pytest.raises(ValueError, match="empty"):
        segmenter.segment_sam2(image, [0, 0, 1, 1], [], [])


def test_nonfinite_score_rejected(image, fake_backend):
    _, _, backend = fake_backend
    backend.model = lambda **kwargs: SimpleNamespace(
        pred_masks=Tensor([0]), iou_scores=Tensor([[[float("nan")]]])
    )
    with pytest.raises(segmenter.SegmenterUnavailable, match="nonfinite"):
        segmenter.segment_sam2(image, [0, 0, 1, 1], [], [])


@pytest.mark.parametrize("missing", [False, True])
def test_loader_requires_local_safe_complete_weights(monkeypatch, tmp_path, missing):
    calls = []

    class Config:
        @staticmethod
        def from_pretrained(path, **kwargs):
            calls.append(("config", path, kwargs))
            return object()

    class Processor:
        @staticmethod
        def from_pretrained(path, **kwargs):
            calls.append(("processor", path, kwargs))
            return object()

    class Model:
        @staticmethod
        def from_pretrained(path, **kwargs):
            calls.append(("model", path, kwargs))
            return Model(), {"missing_keys": ["vision_encoder.weight"] if missing else []}

        def to(self, device):
            return self

        def eval(self):
            return self

    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace())
    monkeypatch.setitem(
        sys.modules,
        "transformers",
        SimpleNamespace(Sam2Config=Config, Sam2Processor=Processor, Sam2Model=Model),
    )
    weights = tmp_path / "model.safetensors"
    weights.write_bytes(b"loader fixture")
    if missing:
        with pytest.raises(segmenter.SegmenterUnavailable, match="could not be loaded"):
            segmenter._load_backend(tmp_path, "cpu", [weights, weights, weights])
    else:
        backend = segmenter._load_backend(tmp_path, "cpu", [weights, weights, weights])
        assert len(backend.checkpoint_sha256) == 64
    assert len(calls) == 3
    assert all(call[2]["local_files_only"] is True for call in calls)
    assert calls[2][2]["use_safetensors"] is True
    assert calls[2][2]["output_loading_info"] is True
