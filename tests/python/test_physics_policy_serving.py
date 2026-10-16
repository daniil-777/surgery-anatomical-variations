"""A failed research application policy cannot silently become the serving default."""
import json
from pathlib import Path

import pytest

from services.api import physics

ROOT = Path(__file__).resolve().parents[2]


def test_research_policy_is_opt_in_and_default_v2_remains_ready(monkeypatch):
    monkeypatch.delenv("VISCERA_PHYSICS_APPLICATION_POLICY", raising=False)
    monkeypatch.setenv("VISCERA_PHYSICS_MODEL", str(ROOT / "artifacts/physics/liver-network-v2"))
    assert physics.application_policy_root() is None
    result = physics.status()
    assert result["status"] == "ready", result
    assert result["application_policy"] is None
    assert result["model_version"] == "liver-inverse-sls-2.0.0"
    monkeypatch.setenv("VISCERA_PHYSICS_APPLICATION_POLICY", "off")
    assert physics.application_policy_root() is None


def test_actual_failed_candidate_is_unavailable_and_cannot_infer(monkeypatch):
    candidate = ROOT / "artifacts/physics/liver-application-policy-v1"
    report = json.loads((candidate / "evaluation.json").read_text())
    assert report["stage"] == "final" and report["all_gates_passed"] is False
    monkeypatch.setenv("VISCERA_PHYSICS_MODEL", str(ROOT / "artifacts/physics/liver-network-v2"))
    monkeypatch.setenv("VISCERA_PHYSICS_APPLICATION_POLICY", str(candidate))
    result = physics.status()
    assert result["status"] == "unavailable"
    assert "evaluation is absent, stale or failed" in result["reason"]
    with pytest.raises(ValueError, match="evaluation is absent, stale or failed"):
        physics.learned_parameters()


def test_explicit_v1_rollback_ignores_optional_v2_policy(monkeypatch):
    monkeypatch.setenv("VISCERA_PHYSICS_MODEL", str(ROOT / "artifacts/physics/liver-network-v1"))
    monkeypatch.setenv("VISCERA_PHYSICS_APPLICATION_POLICY", "/missing/research-policy")
    result = physics.status()
    assert result["status"] == "ready", result
    assert result["application_policy"] is None
    assert result["model_version"] == "liver-inverse-sls-1.0.0"


@pytest.mark.parametrize("change", [
    {"stage": "development"}, {"all_gates_passed": False}, {"gates": {}},
    {"gates": {"precision": 1}}, {"model_sha256": "stale"}, {"policy_sha256": "stale"},
])
def test_policy_evaluation_must_be_final_hash_bound_and_all_boolean_pass(tmp_path, monkeypatch, change):
    from viscera_core import physics_learning_robust

    # Test validation logic without changing or blessing the failed shipped candidate.
    monkeypatch.setattr(physics_learning_robust, "load_policy", lambda *args: ({"version": "test-only"}, "policy-hash"))
    monkeypatch.setenv("VISCERA_PHYSICS_APPLICATION_POLICY", str(tmp_path))
    report = {"stage": "final", "all_gates_passed": True, "gates": {"precision": True},
              "model_sha256": "model-hash", "policy_sha256": "policy-hash"}
    (tmp_path / "evaluation.json").write_text(json.dumps(report | change))
    with pytest.raises(ValueError, match="evaluation is absent, stale or failed"):
        physics.validated_application_policy("model-hash")
