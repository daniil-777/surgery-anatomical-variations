"""Plot frozen synthetic application-policy results; no metric recomputation."""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def main():
    parser = argparse.ArgumentParser(); parser.add_argument("--evaluation", type=Path, required=True); parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(); report = json.loads(args.evaluation.read_text()); cohorts = report["cohorts"]
    plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False})
    fig, axes = plt.subplots(2, 2, figsize=(12, 8), constrained_layout=True)
    colors = ["#74849a", "#146c94"]
    iid = cohorts["iid"]; names = ["young_pa", "relaxation_fraction", "relaxation_time_s"]
    x = np.arange(3)
    for index, (key, label) in enumerate((("v2_accepted", "Original v2"), ("accepted", "Policy 1.2"))):
        values = [100 * iid[key]["p95_relative_error"][name] for name in names]
        bars = axes[0, 0].bar(x + (index - .5) * .35, values, .35, label=label, color=colors[index])
        axes[0, 0].bar_label(bars, fmt="%.1f", padding=2, fontsize=9)
    axes[0, 0].set_xticks(x, ["Young modulus E", "Relaxation fraction g", "Relaxation time τ"])
    axes[0, 0].set_ylabel("Accepted-case p95 relative error (%)"); axes[0, 0].set_title("Lower error tails among accepted estimates")
    axes[0, 0].legend(frameon=False)

    labels = ["IID", "Held-out region", "Higher excitation"]
    selected = [cohorts[key] for key in ("iid", "region", "high_excitation")]
    for index, (key, label) in enumerate((("v2_acceptance", "Original v2"), ("acceptance", "Policy 1.2"))):
        bars = axes[0, 1].bar(x + (index - .5) * .35, [100 * row[key] for row in selected], .35, color=colors[index])
        axes[0, 1].bar_label(bars, fmt="%.1f", padding=2, fontsize=9)
    axes[0, 1].set_xticks(x, labels); axes[0, 1].set_ylim(0, 112); axes[0, 1].set_ylabel("Application acceptance (%)")
    axes[0, 1].set_title("Precision screening deliberately reduces acceptance")

    selected = [cohorts[key] for key in ("two_branch", "nonlinear", "two_branch_high", "nonlinear_high")]
    x = np.arange(4)
    for index, key in enumerate(("v2_acceptance", "acceptance")):
        bars = axes[1, 0].bar(x + (index - .5) * .35, [100 * (1 - row[key]) for row in selected], .35, color=colors[index])
        axes[1, 0].bar_label(bars, fmt="%.1f", padding=2, fontsize=8)
    axes[1, 0].set_xticks(x, ["Two branches", "Nonlinear", "Two branches\nmore excitation", "Nonlinear\nmore excitation"])
    axes[1, 0].set_ylim(0, 112); axes[1, 0].set_ylabel("Application rejection (%)")
    axes[1, 0].set_title("Mismatch detection improves; near-equivalent curves remain")

    keys = ["iid", "noise_low", "noise_high", "noise_correlated"]
    values = [100 * cohorts[key]["structured_check_rejection_rate"] for key in keys]
    bars = axes[1, 1].bar(np.arange(4), values, color=[colors[1]] * 3 + ["#b85c38"])
    axes[1, 1].bar_label(bars, fmt="%.1f", padding=2, fontsize=9)
    axes[1, 1].set_xticks(np.arange(4), ["Calibrated IID", "Low noise", "Higher noise", "Correlated noise"])
    axes[1, 1].set_ylabel("Structured-residual warnings (%)")
    axes[1, 1].set_title("Sensor correlation can also trigger a warning")
    for axis in axes.ravel():
        axis.grid(axis="y", alpha=.18); axis.set_axisbelow(True)
    decision = "Synthetic gates passed" if report["all_gates_passed"] else "NOT PROMOTED: one or more frozen application gates failed"
    fig.suptitle("Liver parameter application policy · frozen synthetic audit\n" + decision + "\nUnchanged v2 neural model; no human tissue validation", fontsize=14)
    args.output.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.output / "robustness-summary.png", dpi=180)
    fig.savefig(args.output / "robustness-summary.pdf")
    plt.close(fig)


if __name__ == "__main__": main()
