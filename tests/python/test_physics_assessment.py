import copy
import json

import numpy as np
import pytest
from viscera_core.physics_assessment import assess_experiment


def sequence():
    return {
        "time_s": [0, 1, 2], "force_n": [0, 2, 0], "displacement_mm": [0, 10, 0],
        "landmarks_mm": [[[0, 0, 0]], [[1, 0, 0]], [[0, 0, 0]]],
        "coordinate_frame": "test_fixture", "camera_id": "camera_1",
    }


def test_identical_calibrated_comparison_is_zero_but_not_physical_validation():
    ref = sequence()
    result = assess_experiment(ref, ref)
    assert result["metrics"]["force"]["rmse_n"] == 0
    assert result["metrics"]["force"]["nrmse"] == 0
    assert result["metrics"]["impulse"]["reference_ns"] == [2]
    assert result["metrics"]["landmarks"]["rmse"] == 0
    assert result["metrics"]["landmarks"]["coverage_in_overlap"] == 1
    assert result["physical_validation"]["status"] == "NOT_ESTABLISHED"
    json.dumps(result, allow_nan=False)


def test_constant_force_offset_and_signed_work_use_si_units():
    ref = {"time_s": [0, 2], "force_n": [2, 2], "displacement_mm": [0, 10]}
    sim = {**ref, "force_n": [3, 3]}
    result = assess_experiment(sim, ref)["metrics"]
    assert result["force"]["rmse_n"] == pytest.approx(1)
    assert result["force"]["nrmse"] == pytest.approx(0.5)
    assert result["impulse"]["error_norm_ns"] == pytest.approx(2)
    assert result["work"]["reference_j"] == pytest.approx(0.02)
    assert result["work"]["absolute_error_j"] == pytest.approx(0.01)


def test_vector_error_cannot_cancel_between_components_or_use_magnitude_only():
    sim = {"time_s": [0, 1], "force_n": [[-1, 0, 0], [-1, 0, 0]]}
    ref = {"time_s": [0, 1], "force_n": [[1, 0, 0], [1, 0, 0]]}
    result = assess_experiment(sim, ref)["metrics"]["force"]
    assert result["rmse_n"] == 2
    assert result["peak_magnitude_error_n"] == 0


def test_alignment_interpolates_only_overlap_and_records_missing_duration():
    sim = {"time_s": [1, 2, 3], "force_n": [1, 2, 3]}
    ref = {"time_s": [0, 2, 4], "force_n": [0, 2, 4]}
    result = assess_experiment(sim, ref)
    assert result["metrics"]["force"]["rmse_n"] == pytest.approx(0)
    assert result["metrics"]["impulse"]["reference_ns"] == [4]
    assert result["alignment"]["reference_duration_coverage"] == 0.5
    assert result["alignment"]["time_warping"] is False


def test_time_weighted_force_error_is_robust_to_redundant_samples():
    ref = {"time_s": [0, 0.01, 0.02, 1], "force_n": [2, 2, 2, 2]}
    sim = {"time_s": [0, 1], "force_n": [3, 3]}
    assert assess_experiment(sim, ref)["metrics"]["force"]["nrmse"] == 0.5


def test_linear_force_rmse_uses_exact_piecewise_linear_time_integral():
    ref = {"time_s": [0, 1], "force_n": [0, 0]}
    sim = {"time_s": [0, 1], "force_n": [0, 1]}
    metric = assess_experiment(sim, ref)["metrics"]["force"]
    assert metric["rmse_n"] == pytest.approx(np.sqrt(1/3))
    sim["time_s"], sim["force_n"] = [0, 0.1, 0.4, 1], [0, 0.1, 0.4, 1]
    assert assess_experiment(sim, ref)["metrics"]["force"]["rmse_n"] == pytest.approx(metric["rmse_n"])


def test_missing_visibility_is_counted_not_interpolated_through():
    ref, sim = sequence(), sequence()
    sim["visibility"] = [[True], [False], [True]]
    sim["landmarks_mm"][1] = [[float("nan"), 0, 0]]
    result = assess_experiment(sim, ref)
    landmark = result["metrics"]["landmarks"]
    assert landmark["compared_samples"] == 2
    assert landmark["missing_samples_in_overlap"] == 1
    assert landmark["coverage_of_all_visible_reference"] == pytest.approx(2/3)
    json.dumps(result, allow_nan=False)


def test_partial_landmark_coverage_includes_outside_time_overlap():
    ref = sequence()
    sim = {"time_s": [1, 2], "landmarks_mm": ref["landmarks_mm"][1:]}
    result = assess_experiment(sim, ref)["metrics"]["landmarks"]
    assert result["reference_samples_outside_overlap"] == 1
    assert result["coverage_of_all_visible_reference"] == pytest.approx(2/3)


def test_landmark_offset_reports_euclidean_mm_and_pixels_stay_pixels():
    ref, sim = sequence(), sequence()
    sim["landmarks_mm"] = (np.asarray(sim["landmarks_mm"])+[3, 4, 0]).tolist()
    metric = assess_experiment(sim, ref)["metrics"]["landmarks"]
    assert metric["rmse"] == metric["p95"] == 5
    for item in (sim, ref):
        item["landmarks_px"] = np.asarray(item.pop("landmarks_mm"))[:, :, :2].tolist()
    metric = assess_experiment(sim, ref)["metrics"]["landmarks"]
    assert metric["units"] == "px"
    assert "no metric" in metric["interpretation"]


def test_zero_reference_force_keeps_nrmse_null_and_json_finite():
    ref = {"time_s": [0, 1], "force_n": [0, 0]}
    sim = {"time_s": [0, 1], "force_n": [1, 1]}
    result = assess_experiment(sim, ref)
    assert result["metrics"]["force"]["rmse_n"] == 1
    assert result["metrics"]["force"]["nrmse"] is None
    json.dumps(result, allow_nan=False)


def test_missing_reference_and_inversions_are_separate_from_validation():
    result = assess_experiment({"metrics": {"minimum_jacobian": -0.1,
        "inverted_elements": 2, "finite_state": True}})
    assert result["status"] == "NOT_RUN"
    assert result["numerical"]["status"] == "FAIL"
    assert "inverted_elements" in result["numerical"]["hard_failures"]
    assert all(metric["status"] == "NOT_RUN" for metric in result["metrics"].values())
    assert result["physical_validation"]["status"] == "NOT_ESTABLISHED"


def test_runtime_frames_adapter_does_not_claim_nodes_are_measured_landmarks():
    sim = {"frames": [{"time_s": t, "tool_force_n": [0, 0, 2],
                       "tool_position_mm": [0, 0, t*10], "positions_mm": [0, 0, 0]}
                      for t in (0, 1)], "metrics": {"minimum_jacobian": 1}, "protocol": "indent"}
    report = assess_experiment(sim, copy.deepcopy(sim))
    assert report["metrics"]["force"]["rmse_n"] == 0
    assert report["metrics"]["work"]["reference_j"] == pytest.approx(0.02)
    assert report["metrics"]["landmarks"]["status"] == "NOT_RUN"
    assert report["numerical"]["observations"]["frame_positions_finite"]


def test_declared_relaxation_and_recovery_windows():
    ref = {"time_s": [0, 1, 2, 3], "force_n": [0, 4, 2, 0],
           "landmarks_mm": [[[0, 0, 0]], [[2, 0, 0]], [[2, 0, 0]], [[0.1, 0, 0]]],
           "protocol": {"hold_start_s": 1, "hold_end_s": 2,
                        "release_time_s": 2, "recovery_end_s": 3}}
    metrics = assess_experiment(ref, ref)["metrics"]
    assert metrics["relaxation"]["normalized_trace_rmse"] == 0
    assert metrics["relaxation"]["reference_end_to_start_ratio"] == 0.5
    assert metrics["recovery"]["reference_residual_rms"] == pytest.approx(0.1)
    assert metrics["recovery"]["residual_vector_rmse"] == 0


def test_silhouette_iou_uses_exact_time_pairs_and_excludes_empty_pairs():
    ref = {"time_s": [0, 1, 2], "silhouettes": [[[1, 0]], [[0, 0]], [[1, 1]]]}
    sim = {"time_s": [0, 1, 2], "silhouettes": [[[1, 1]], [[0, 0]], [[1, 1]]]}
    metric = assess_experiment(sim, ref)["metrics"]["silhouette"]
    assert metric["mean_iou"] == 0.75
    assert metric["empty_pairs_excluded"] == 1


def test_large_gap_is_explicitly_rejected_when_bound_is_supplied():
    ref = {"time_s": [0, 1], "force_n": [1, 1], "max_interpolation_gap_s": 0.1}
    assert assess_experiment(ref, ref)["metrics"]["force"]["status"] == "NOT_RUN"


@pytest.mark.parametrize("change,match", [
    ({"time_s": [0, 0, 1]}, "strictly increasing"),
    ({"time_s": [0, float("nan"), 1]}, "finite"),
    ({"time_s": [4, 5, 6]}, "overlap"),
    ({"force_n": [1, float("inf"), 1]}, "finite"),
    ({"force_n": [[1, 1, 1]]*3}, "component"),
    ({"units": {"force": "kN"}}, "units"),
    ({"coordinate_frame": "unregistered"}, "coordinate_frame"),
    ({"visibility": [[1, 1]]*3}, "visibility"),
    ({"landmark_ids": ["a"]}, "landmark_ids"),
])
def test_guard_invalid_or_incompatible_observations(change, match):
    sim = {**sequence(), **change}
    with pytest.raises(ValueError, match=match):
        assess_experiment(sim, sequence())


def test_nonfinite_numerical_observation_is_json_safe_failure():
    result = assess_experiment({"metrics": {"minimum_jacobian": float("nan")}})
    assert result["numerical"]["status"] == "FAIL"
    json.dumps(result, allow_nan=False)


def test_rejected_or_unconverged_steps_cannot_be_hidden_by_finite_coordinates():
    result = assess_experiment({"metrics": {
        "finite_state": True, "minimum_jacobian": 0.9, "rejected_steps": 1,
        "unconverged_steps": 2,
    }})
    assert result["numerical"]["status"] == "FAIL"
    assert set(result["numerical"]["hard_failures"]) == {"rejected_steps", "unconverged_steps"}
