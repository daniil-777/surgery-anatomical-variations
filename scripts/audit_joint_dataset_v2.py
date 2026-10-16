"""Verify full paired-cohort lineage and the recorded all-source precision ledger."""

import argparse
import json
from collections import Counter
from pathlib import Path

import numpy as np
from viscera_core.atlas_joint_v2 import verify_release


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dataset-root",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "artifacts/joint-v2",
    )
    parser.add_argument("--minimum-records", type=int, default=56832)
    args = parser.parse_args()
    root = args.dataset_root

    verify_release(root / "baseline")
    verify_release(root / "disease")
    br = [json.loads(line) for line in (root / "baseline/manifest.jsonl").open()]
    dr = [json.loads(line) for line in (root / "disease/manifest.jsonl").open()]
    bg = {r["group_id"]: r for r in br}
    assert len(bg) == len(br)
    splits = {s: {r["group_id"] for r in br if r["split"] == s} for s in ["train", "val", "audit"]}
    brelease = json.loads((root / "baseline/release.json").read_text())
    drelease = json.loads((root / "disease/release.json").read_text())
    assert len(br) == brelease["samples"] and len(dr) == drelease["samples"]
    assert len(br) + len(dr) >= args.minimum_records
    assert brelease["points_per_sample"] == drelease["points_per_sample"]
    point_count = brelease["points_per_sample"]
    assert all(not splits[a] & splits[b] for a in splits for b in splits if a != b)
    assert all(
        bg[r["group_id"]]["split"] == r["split"]
        and bg[r["group_id"]]["renderer_seeds"][0] == r["renderer_seeds"][0]
        for r in dr
    )
    control_checks = 0
    for split in splits:
        with np.load(root / "baseline" / (split + ".npz"), allow_pickle=False) as f:
            bc = {g: x[:13] for g, x in zip(f["group_ids"], f["controls"], strict=True)}
        with np.load(root / "disease" / (split + ".npz"), allow_pickle=False) as f:
            groups = f["group_ids"]
            controls = f["controls"]
        for g, x in zip(groups, controls, strict=True):
            np.testing.assert_array_equal(bc[g], x[:13])
            control_checks += 1
    qa = [r for r in br + dr if r["full_mesh_qa"]]
    assert len(qa) == len(br) + len(dr)
    assert all(
        r["full_mesh_qa"]["passed"]
        and r["full_mesh_qa"]["ignored_degenerate_source_faces"] == 0
        and r["full_mesh_qa"]["opposed_transported_face_normals"] == 0
        and r["full_mesh_qa"]["new_degenerate_faces"] == 0
        for r in qa
    )
    assert all(
        all(
            q["finite"]
            and q["opposed_transported_face_normals"] == 0
            and q["new_degenerate_faces"] == 0
            for q in r["full_mesh_qa"]["precision_checks"].values()
        )
        for r in qa
    )
    summary = {
        "status": "PASS",
        "baseline_records": len(br),
        "disease_records": len(dr),
        "total_records": len(br) + len(dr),
        "unique_synthetic_families": len(bg),
        "independent_patient_count": 0,
        "profiles": len({r["profile_id"] for r in dr}),
        "templates": len({r["template_id"] for r in br}),
        "points_per_record": point_count,
        "paired_surface_queries": (len(br) + len(dr)) * point_count,
        "family_split_leakage_count": 0,
        "paired_shape_material_controls_bitwise_equal_checks": control_checks,
        "paired_material_phase_checks": len(dr),
        "disease_severity_counts": dict(Counter(r["severity_id"] for r in dr)),
        "condition_count_distribution": dict(
            Counter(Counter((r["template_id"], r["profile_id"]) for r in dr).values())
        ),
        "full_source_mesh_qa_count": len(qa),
        "full_source_mesh_qa_failures": sum(not r["full_mesh_qa"]["passed"] for r in qa),
        "full_source_normal_turn_diagnostic_cases": sum(
            r["full_mesh_qa"]["normal_turns_over_90_degrees"] > 0 for r in qa
        ),
        "source_limited_disease_rows": sum(r["displacement_fraction"] < 1 for r in dr),
        "zeroed_local_field_rows": sum(r["displacement_fraction"] == 0 for r in dr),
        "no_visible_mask_anchor_rows": sum(r["lesion_visible_anchor_count"] == 0 for r in dr),
        "scope": "full scalar/control/family ledger audit; every accepted recipe includes all-source float64/Studiofloat32mm/glTFfloat32m face QA; not intersection or clinical certification",
        "minimum_all_precision_alignment": min(
            r["full_mesh_qa"]["minimum_all_precision_alignment"] for r in qa
        ),
        "maximum_vertex_roundtrip_error_mm": max(
            q["maximum_vertex_roundtrip_error_mm"]
            for r in qa
            for q in r["full_mesh_qa"]["precision_checks"].values()
        ),
        "baseline_shape_projected_rows": sum(r["source_safe_shape_fraction"] < 1 for r in br),
        "disease_shape_projected_rows": sum(r["source_safe_shape_fraction"] < 1 for r in dr),
        "layout_resampled_rows": sum(r["layout_resampling_attempts"] > 0 for r in dr),
        "baseline_rejections": brelease["rejected_samples"],
        "disease_rejections": drelease["rejected_samples"],
        "release_ids": {"baseline": brelease["release_id"], "disease": drelease["release_id"]},
    }
    (root / "cohort_integrity_audit.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
