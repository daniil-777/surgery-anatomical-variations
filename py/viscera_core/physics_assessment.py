"""Compare synchronized mechanics observations without claiming tissue validation.

Signals use unit-bearing names: time_s, force_n, tool_position_m (or
tool_position_mm / displacement_mm), landmarks_mm (or landmarks_px), visibility,
and silhouettes. Arrays have time first; landmark arrays are [time, point, xyz]
or [time, point, xy]. The liver laboratory's frames/metrics envelope is accepted.
No camera reconstruction, force inference, time shifting or time warping occurs.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from numpy.typing import NDArray

FloatArray = NDArray[np.float64]
BoolArray = NDArray[np.bool_]


def _not_run(reason: str) -> dict[str, Any]:
    return {"status": "NOT_RUN", "reason": reason}


def _array(value: Any, name: str, *, finite: bool = True) -> FloatArray:
    try:
        array = np.asarray(value, dtype=np.float64)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a numeric array") from exc
    if finite and not np.isfinite(array).all():
        raise ValueError(f"{name} must contain finite values")
    return array


def _sequence(sequence: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(sequence, dict):
        raise ValueError("Each experiment must be an object")
    result = dict(sequence)
    if isinstance(result.get("protocol"), str):
        result["protocol_name"] = result["protocol"]
        result["protocol"] = result.get("protocol_windows", {})
    frames = result.get("frames")
    if frames is not None:
        if not isinstance(frames, list) or not frames:
            raise ValueError("frames must be a nonempty list")
        for source, target in (
            ("time_s", "time_s"),
            ("tool_force_n", "force_n"),
            ("tool_position_mm", "tool_position_mm"),
            ("landmarks_mm", "landmarks_mm"),
            ("landmarks_px", "landmarks_px"),
            ("visibility", "visibility"),
            ("silhouette", "silhouettes"),
        ):
            present = [isinstance(frame, dict) and source in frame for frame in frames]
            if any(present) and not all(present):
                raise ValueError(f"Frame field {source} must be present in every frame")
            if all(present) and target not in result:
                result[target] = [frame[source] for frame in frames]
    if "times_s" in result:
        if "time_s" in result and not np.array_equal(result["time_s"], result["times_s"]):
            raise ValueError("time_s and times_s disagree")
        result["time_s"] = result["times_s"]
    units = result.get("units", {})
    if not isinstance(units, dict):
        raise ValueError("units must be an object")
    expected = {
        "time": "s", "time_s": "s", "force": "N", "force_n": "N",
        "tool_position_m": "m", "tool_position_mm": "mm", "displacement_mm": "mm",
        "landmarks_mm": "mm", "landmarks_px": "px",
    }
    for key, value in units.items():
        if key in expected and value != expected[key]:
            raise ValueError(f"{key} units must be {expected[key]}")
    return result


def _time(sequence: dict[str, Any], name: str) -> FloatArray:
    if "time_s" not in sequence:
        raise ValueError(f"{name} needs time_s or timestamped frames")
    times = _array(sequence["time_s"], f"{name}.time_s")
    if times.ndim != 1 or len(times) < 2 or np.any(np.diff(times) <= 0):
        raise ValueError(f"{name}.time_s must have at least two strictly increasing timestamps")
    return times


def _signal(sequence: dict[str, Any], key: str, size: int) -> FloatArray | None:
    if key not in sequence:
        return None
    array = _array(sequence[key], key)
    if array.ndim not in (1, 2) or len(array) != size:
        raise ValueError(f"{key} must have one scalar or vector per timestamp")
    if array.ndim == 2 and array.shape[1] not in (1, 2, 3):
        raise ValueError(f"{key} vectors must have 1, 2 or 3 components")
    return array.reshape(size, -1)


def _interp(times: FloatArray, values: FloatArray, grid: FloatArray) -> FloatArray:
    flat = values.reshape(len(times), -1)
    result = np.column_stack([np.interp(grid, times, column) for column in flat.T])
    return result.reshape((len(grid),) + values.shape[1:])


def _integral(values: FloatArray, times: FloatArray) -> FloatArray:
    return np.asarray(np.trapezoid(values, x=times, axis=0))


def _mean_square(values: FloatArray, times: FloatArray) -> FloatArray:
    """Exact integral of the square of each piecewise-linear component."""
    flat = values.reshape(len(times), -1)
    a, b = flat[:-1], flat[1:]
    integral = np.sum(np.diff(times)[:, None] * (a*a+a*b+b*b)/3, axis=0)
    return integral/(times[-1]-times[0])


def _rmse(values: FloatArray, times: FloatArray) -> float:
    return float(np.sqrt(_mean_square(values, times).sum()))


def _ratio(numerator: float, denominator: float) -> float | None:
    return numerator / denominator if denominator > 1e-12 else None


def _numerical(sequence: dict[str, Any]) -> dict[str, Any]:
    source = sequence.get("metrics", sequence.get("numerical", {}))
    if not isinstance(source, dict):
        raise ValueError("Numerical metrics must be an object")
    fields = (
        "minimum_jacobian", "maximum_volume_error_pct", "inverted_elements",
        "peak_tool_force_n", "peak_displacement_mm", "residual_displacement_mm",
        "rejected_steps", "mean_step_ms", "p95_step_ms", "severed_bonds",
        "fracture_dissipation_j", "finite_state",
        "unconverged_steps", "maximum_stationarity_residual_n", "total_seam_bonds",
    )
    observations: dict[str, Any] = {}
    failures = []
    for key in fields:
        if key not in source:
            continue
        value = source[key]
        if key == "finite_state":
            if not isinstance(value, (bool, np.bool_)):
                raise ValueError("finite_state must be boolean")
            observations[key] = bool(value)
            if not value:
                failures.append("nonfinite_state")
        else:
            array = _array(value, key, finite=False)
            if array.ndim != 0:
                raise ValueError(f"Numerical metric {key} must be a scalar")
            numeric = float(array)
            observations[key] = numeric if np.isfinite(numeric) else None
            if not np.isfinite(numeric):
                failures.append(f"nonfinite_{key}")
            elif key == "minimum_jacobian" and numeric <= 0:
                failures.append("nonpositive_element_jacobian")
            elif key == "inverted_elements" and numeric > 0:
                failures.append("inverted_elements")
            elif key in ("rejected_steps", "unconverged_steps") and numeric > 0:
                failures.append(key)
            elif key != "minimum_jacobian" and numeric < 0:
                raise ValueError(f"Numerical metric {key} must be nonnegative")
    frames = sequence.get("frames", [])
    if frames and all("positions_mm" in frame for frame in frames):
        finite = all(np.isfinite(_array(frame["positions_mm"], "positions_mm", finite=False)).all()
                     for frame in frames)
        observations["frame_positions_finite"] = bool(finite)
        if not finite:
            failures.append("nonfinite_frame_positions")
    if not observations:
        return _not_run("No numerical integrity observations supplied")
    return {
        "status": "FAIL" if failures else "COMPUTED",
        "observations": observations,
        "hard_failures": failures,
        "interpretation": "Numerical diagnostics; no physical-validation conclusion or tolerance gate",
    }


def _landmarks(sequence: dict[str, Any], size: int) -> tuple[FloatArray, BoolArray, str] | None:
    keys = [key for key in ("landmarks_mm", "landmarks_px") if key in sequence]
    if not keys:
        return None
    if len(keys) != 1:
        raise ValueError("Provide landmarks_mm or landmarks_px, not both")
    key = keys[0]
    array = _array(sequence[key], key, finite=False)
    dimensions = 3 if key.endswith("mm") else 2
    if array.ndim != 3 or array.shape[0] != size or array.shape[1] == 0:
        raise ValueError(f"{key} must have shape [time, point, coordinate]")
    if array.shape[2] != dimensions:
        raise ValueError(f"{key} needs {dimensions} coordinates per landmark")
    valid = np.isfinite(array).all(axis=2)
    if "visibility" in sequence:
        visibility = np.asarray(sequence["visibility"])
        if visibility.shape != valid.shape or not np.isin(visibility, (True, False)).all():
            raise ValueError("visibility must be a boolean [time, point] mask")
        valid &= visibility.astype(bool)
    return array, valid, "mm" if dimensions == 3 else "px"


def _landmark_at(times: FloatArray, values: FloatArray, visible: BoolArray,
                 grid: FloatArray, gap_limit: float | None) -> tuple[FloatArray, BoolArray]:
    right = np.searchsorted(times, grid, side="left").clip(0, len(times) - 1)
    exact = np.isclose(times[right], grid, rtol=0, atol=1e-12)
    left = np.where(exact, right, (right - 1).clip(0))
    valid = visible[left] & visible[right]
    if gap_limit is not None:
        valid &= ((times[right] - times[left]) <= gap_limit)[:, None]
    clean = np.where(np.isfinite(values), values, 0.0)
    return _interp(times, clean, grid), valid


def _landmark_report(simulation: dict[str, Any], reference: dict[str, Any], st: FloatArray,
                     rt: FloatArray, start: float, end: float,
                     gap_limit: float | None) -> dict[str, Any]:
    sim, ref = _landmarks(simulation, len(st)), _landmarks(reference, len(rt))
    if sim is None or ref is None:
        return _not_run("Both sequences need corresponding calibrated landmarks or pixel tracks")
    sp, sv, units = sim
    rp, rv, runits = ref
    if units != runits or sp.shape[1:] != rp.shape[1:]:
        raise ValueError("Landmark units, count and coordinate dimensions must match")
    sid, rid = simulation.get("landmark_ids"), reference.get("landmark_ids")
    if (sid is None) != (rid is None) or (sid is not None and sid != rid):
        raise ValueError("landmark_ids must have identical order in both sequences")
    if sid is not None and (len(sid) != sp.shape[1] or len(set(sid)) != len(sid)):
        raise ValueError("landmark_ids must be unique and match the point count")
    selected = (rt >= start) & (rt <= end)
    grid = rt[selected]
    expected = int(rv.sum())
    if not len(grid):
        return _not_run("No native reference landmark timestamps lie in the overlap")
    predicted, predicted_visible = _landmark_at(st, sp, sv, grid, gap_limit)
    valid = predicted_visible & rv[selected]
    compared = int(valid.sum())
    available = int(rv[selected].sum())
    report: dict[str, Any] = {
        "status": "COMPUTED" if compared else "NOT_RUN",
        "units": units,
        "reference_visible_samples_total": expected,
        "reference_visible_samples_in_overlap": available,
        "compared_samples": compared,
        "missing_samples_in_overlap": available - compared,
        "reference_samples_outside_overlap": expected - available,
        "coverage_of_all_visible_reference": _ratio(float(compared), float(expected)),
        "coverage_in_overlap": _ratio(float(compared), float(available)),
        "reference_observation_fraction": float(rv.mean()),
        "sampling": "native reference timestamps; interpolate simulation only across visible endpoints",
        "correspondence": "landmark_ids" if sid is not None else "caller-declared matching point order",
        "rmse": None, "p95": None, "maximum": None,
    }
    if compared:
        errors = np.linalg.norm(predicted - rp[selected], axis=2)[valid]
        report.update(rmse=float(np.sqrt(np.mean(errors**2))),
                      p95=float(np.percentile(errors, 95)), maximum=float(errors.max()))
    else:
        report["reason"] = "No mutually visible finite landmark observations"
    if units == "px":
        report["interpretation"] = "Image-space tracking only; no metric 3D mechanics conclusion"
    return report


def _silhouette_report(simulation: dict[str, Any], reference: dict[str, Any], st: FloatArray,
                       rt: FloatArray, start: float, end: float) -> dict[str, Any]:
    if "silhouettes" not in simulation or "silhouettes" not in reference:
        return _not_run("Both sequences need binary silhouettes from the same camera")
    masks = []
    for sequence, times in ((simulation, st), (reference, rt)):
        mask = np.asarray(sequence["silhouettes"])
        if mask.ndim != 3 or mask.shape[0] != len(times) or min(mask.shape[1:]) == 0:
            raise ValueError("silhouettes must have shape [time, height, width]")
        if not np.isin(mask, (True, False)).all():
            raise ValueError("silhouettes must be binary")
        masks.append(mask.astype(bool))
    if masks[0].shape[1:] != masks[1].shape[1:]:
        raise ValueError("Silhouettes must use identical image dimensions")
    scores = []
    empty_pairs = 0
    for index in np.flatnonzero((rt >= start) & (rt <= end)):
        matches = np.flatnonzero(np.isclose(st, rt[index], rtol=0, atol=1e-9))
        if not len(matches):
            continue
        a, b = masks[0][matches[0]], masks[1][index]
        union = int((a | b).sum())
        if not union:
            empty_pairs += 1
            continue
        scores.append(float((a & b).sum() / union))
    return {
        "status": "COMPUTED" if scores else "NOT_RUN",
        "mean_iou": float(np.mean(scores)) if scores else None,
        "compared_frames": len(scores), "empty_pairs_excluded": empty_pairs,
        "reference_frames_total": len(rt),
        "coverage": float(len(scores) / len(rt)),
        "sampling": "exact timestamps only; no temporal interpolation of binary masks",
        "reason": None if scores else "No nonempty silhouette pairs at matching timestamps",
    }


def _displacement(sequence: dict[str, Any], size: int) -> FloatArray | None:
    keys = [key for key in ("tool_position_m", "tool_position_mm", "displacement_mm")
            if key in sequence]
    if not keys:
        return None
    if len(keys) > 1:
        raise ValueError("Provide only one tool position/displacement field")
    result = _signal(sequence, keys[0], size)
    assert result is not None
    return result if keys[0].endswith("_m") else result * 0.001


def _protocol_window(protocol: dict[str, Any], first: str, last: str,
                     start: float, end: float) -> tuple[float, float] | None:
    if first not in protocol or last not in protocol:
        return None
    a, b = float(protocol[first]), float(protocol[last])
    if not np.isfinite([a, b]).all() or b <= a:
        raise ValueError(f"{first}/{last} must define an increasing finite time interval")
    return (a, b) if a >= start and b <= end else None


def assess_experiment(simulation: dict[str, Any],
                      reference: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return JSON-safe errors and coverage; missing evidence is NOT_RUN.

    Reference protocol may provide hold_start_s/hold_end_s and
    release_time_s/recovery_end_s. The latter reports residual *observed surface*
    displacement relative to each sequence's first state; no recovery claim is
    inferred from tool motion. Coordinate frames and camera IDs, when provided,
    must match. Otherwise they remain caller assumptions in the report.
    """
    sim = _sequence(simulation)
    names = ("force", "impulse", "work", "landmarks", "silhouette", "relaxation", "recovery")
    report: dict[str, Any] = {
        "schema_version": "liver_physics_assessment_v1",
        "numerical": _numerical(sim),
        "physical_validation": {
            "status": "NOT_ESTABLISHED",
            "reason": "Errors alone do not establish independent tissue validation or clinical fidelity",
        },
        "metrics": {key: _not_run("No reference sequence supplied") for key in names},
        "alignment": _not_run("No reference sequence supplied"),
    }
    if reference is None:
        report["status"] = "NOT_RUN"
        return report
    ref = _sequence(reference)
    st, rt = _time(sim, "simulation"), _time(ref, "reference")
    for key in ("coordinate_frame", "camera_id"):
        if key in sim and key in ref and sim[key] != ref[key]:
            raise ValueError(f"{key} mismatch; register observations before assessment")
    start, end = max(st[0], rt[0]), min(st[-1], rt[-1])
    if end <= start:
        raise ValueError("Sequences need a positive common time overlap; no time shifting is applied")
    grid = np.unique(np.r_[st[(st >= start) & (st <= end)],
                           rt[(rt >= start) & (rt <= end)], start, end])
    limit = ref.get("max_interpolation_gap_s", sim.get("max_interpolation_gap_s"))
    if limit is not None:
        limit = float(limit)
        if not np.isfinite(limit) or limit <= 0:
            raise ValueError("max_interpolation_gap_s must be finite and positive")
    max_gap = max(float(np.diff(times)[(times[:-1] < end) & (times[1:] > start)].max())
                  for times in (st, rt))
    force_gap_valid = limit is None or max_gap <= limit
    report["status"] = "COMPUTED"
    report["reference_evidence_kind"] = ref.get("evidence_kind", ref.get("evidence", "unspecified"))
    report["alignment"] = {
        "status": "COMPUTED", "method": "piecewise linear interpolation on common-overlap union grid",
        "time_warping": False, "start_s": float(start), "end_s": float(end),
        "sample_count": len(grid), "duration_s": float(end - start),
        "simulation_duration_coverage": float((end-start)/(st[-1]-st[0])),
        "reference_duration_coverage": float((end-start)/(rt[-1]-rt[0])),
        "maximum_native_interval_s": max_gap, "max_interpolation_gap_s": limit,
        "coordinate_frame": ref.get("coordinate_frame", sim.get("coordinate_frame")),
        "coordinate_frame_checked": "coordinate_frame" in sim and "coordinate_frame" in ref,
        "camera_checked": "camera_id" in sim and "camera_id" in ref,
    }
    metrics = report["metrics"]
    sf, rf = _signal(sim, "force_n", len(st)), _signal(ref, "force_n", len(rt))
    force_ready = sf is not None and rf is not None and force_gap_valid
    if sf is not None and rf is not None and sf.shape[1] != rf.shape[1]:
        raise ValueError("Force component counts must match; magnitude is not a force vector")
    if force_ready:
        assert sf is not None and rf is not None
        fs, fr = _interp(st, sf, grid), _interp(rt, rf, grid)
        difference = fs - fr
        error, norm = _rmse(difference, grid), _rmse(fr, grid)
        component = np.sqrt(_mean_square(difference, grid))
        metrics["force"] = {
            "status": "COMPUTED", "rmse_n": error, "component_rmse_n": component.tolist(),
            "nrmse": _ratio(error, norm), "normalization_n": norm,
            "normalization": "time-weighted RMS reference force-vector magnitude",
            "peak_magnitude_error_n": float(abs(np.linalg.norm(fs, axis=1).max()
                                               - np.linalg.norm(fr, axis=1).max())),
            "maximum_vector_error_n": float(np.linalg.norm(difference, axis=1).max()),
        }
        impulse_s, impulse_r = _integral(fs, grid), _integral(fr, grid)
        impulse_error = float(np.linalg.norm(impulse_s-impulse_r))
        metrics["impulse"] = {
            "status": "COMPUTED", "simulation_ns": impulse_s.tolist(),
            "reference_ns": impulse_r.tolist(), "error_norm_ns": impulse_error,
            "relative_error": _ratio(impulse_error, float(np.linalg.norm(impulse_r))),
            "definition": "signed force-vector integral over common overlap",
        }
        sd, rd = _displacement(sim, len(st)), _displacement(ref, len(rt))
        if sd is not None and rd is not None:
            if sd.shape[1] != sf.shape[1] or rd.shape[1] != rf.shape[1]:
                raise ValueError("Work needs displacement and force with matching components")
            ds, dr = _interp(st, sd, grid), _interp(rt, rd, grid)
            ws = float(np.sum((fs[1:]+fs[:-1])*0.5*np.diff(ds, axis=0)))
            wr = float(np.sum((fr[1:]+fr[:-1])*0.5*np.diff(dr, axis=0)))
            metrics["work"] = {
                "status": "COMPUTED", "simulation_j": ws, "reference_j": wr,
                "absolute_error_j": abs(ws-wr), "relative_error": _ratio(abs(ws-wr), abs(wr)),
                "definition": "signed trapezoidal integral of force dot tool displacement",
                "assumption": "Provided force and displacement are work-conjugate in one registered frame",
            }
        else:
            metrics["work"] = _not_run("Both sequences need tool position/displacement in stated units")
    else:
        reason = "Force samples exceed max_interpolation_gap_s" if not force_gap_valid else (
            "Both sequences need measured/provided force_n")
        for key in ("force", "impulse", "work"):
            metrics[key] = _not_run(reason)
    metrics["landmarks"] = _landmark_report(sim, ref, st, rt, start, end, limit)
    metrics["silhouette"] = _silhouette_report(sim, ref, st, rt, start, end)
    protocol = ref.get("protocol", {})
    if not isinstance(protocol, dict):
        raise ValueError("Reference protocol must be an object")
    hold = _protocol_window(protocol, "hold_start_s", "hold_end_s", start, end)
    metrics["relaxation"] = _not_run("Need force and a complete declared hold window in the overlap")
    if hold is not None and force_ready:
        hold_grid = np.unique(np.r_[grid[(grid >= hold[0]) & (grid <= hold[1])], hold])
        assert sf is not None and rf is not None
        hs = np.linalg.norm(_interp(st, sf, hold_grid), axis=1)
        hr = np.linalg.norm(_interp(rt, rf, hold_grid), axis=1)
        if hs[0] > 1e-12 and hr[0] > 1e-12:
            normalized = hs/hs[0] - hr/hr[0]
            metrics["relaxation"] = {
                "status": "COMPUTED", "hold_duration_s": hold[1]-hold[0],
                "normalized_trace_rmse": _rmse(normalized, hold_grid),
                "simulation_end_to_start_ratio": float(hs[-1]/hs[0]),
                "reference_end_to_start_ratio": float(hr[-1]/hr[0]),
                "interpretation": "Declared displacement hold; end-of-window is not assumed equilibrium",
            }
        else:
            metrics["relaxation"] = _not_run("Hold starts with zero force; normalization is undefined")
    recovery = _protocol_window(protocol, "release_time_s", "recovery_end_s", start, end)
    metrics["recovery"] = _not_run("Need landmarks and a complete declared recovery window")
    sl, rl = _landmarks(sim, len(st)), _landmarks(ref, len(rt))
    if recovery is not None and sl is not None and rl is not None:
        if abs(st[0]-rt[0]) > 1e-9:
            metrics["recovery"] = _not_run("Recovery needs a shared initial reference-state timestamp")
        else:
            sp, sv, unit = sl
            rp, rv, _ = rl
            terminal = np.array([recovery[1]])
            sx, sm = _landmark_at(st, sp, sv, terminal, limit)
            rx, rm = _landmark_at(rt, rp, rv, terminal, limit)
            valid = sm[0] & rm[0] & sv[0] & rv[0]
            if valid.any():
                sdelta, rdelta = sx[0, valid]-sp[0, valid], rx[0, valid]-rp[0, valid]
                metrics["recovery"] = {
                    "status": "COMPUTED", "units": unit, "duration_after_release_s": recovery[1]-recovery[0],
                    "compared_landmarks": int(valid.sum()), "landmark_count": len(valid),
                    "simulation_residual_rms": float(np.sqrt(np.mean(np.sum(sdelta**2, axis=1)))),
                    "reference_residual_rms": float(np.sqrt(np.mean(np.sum(rdelta**2, axis=1)))),
                    "residual_vector_rmse": float(np.sqrt(np.mean(np.sum((sdelta-rdelta)**2, axis=1)))),
                    "interpretation": "Relative to shared initial observed state; not an assumed stress-free state",
                }
    return report
