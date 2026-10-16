"""Produce neutral review views; renders are procedural evidence, not anatomy approval."""

import argparse
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LightSource
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
from viscera_core.geometry import DEFAULT_PARAMETERS, generate_scene, sample_parameters


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--profile", choices=("adult_design_v1", "control_stress"), default="adult_design_v1"
    )
    args = parser.parse_args()
    designs = [
        ("Authored default", {}),
        ("Broader left lobe", {"left_lobe_ratio": 0.75}),
        ("Tapered left lobe", {"left_lobe_ratio": 0.32}),
        ("Deeper visceral features", {"inferior_concavity": 0.50, "fissure_depth_mm": 11}),
        ("Compact design", {"liver_width_mm": 200, "liver_height_mm": 125, "liver_depth_mm": 120}),
        ("Larger design", {"liver_width_mm": 285, "liver_height_mm": 175, "liver_depth_mm": 175}),
        ("Long narrow gallbladder", {"gallbladder_length_mm": 105, "gallbladder_radius_mm": 11}),
        ("Short broad gallbladder", {"gallbladder_length_mm": 60, "gallbladder_radius_mm": 20}),
    ]
    if args.profile == "adult_design_v1":
        designs = [
            (
                f"Adult design seed {index + 1}",
                sample_parameters(20261006 + index * 104729, profile="adult_design_v1"),
            )
            for index in range(8)
        ]
    figure = plt.figure(figsize=(16, 9), facecolor="#eeeeed")
    for index, (title, changes) in enumerate(designs):
        scene = generate_scene(
            {"parameters": {**DEFAULT_PARAMETERS, **changes}, "include_vessels": False},
            "medium",
            include_simulation=False,
        )
        axes = figure.add_subplot(2, 4, index + 1, projection="3d")
        for organ in scene["organs"]:
            vertices = np.asarray(organ["positions"]).reshape(-1, 3)
            faces = np.asarray(organ["indices"]).reshape(-1, 3)
            axes.add_collection3d(
                Poly3DCollection(
                    vertices[faces],
                    facecolors=organ["color"],
                    linewidth=0,
                    shade=True,
                    lightsource=LightSource(azdeg=35, altdeg=45),
                )
            )
        axes.set(
            xlim=(-115, 185),
            ylim=(-110, 120),
            zlim=(-55, 200),
            title=f"{title}\n{scene['measurements']['liver_volume_ml']:.0f} mL outer envelope",
        )
        axes.set_box_aspect((300, 230, 255))
        axes.view_init(elev=-35, azim=105)
        axes.set_axis_off()
    figure.suptitle(
        f"{args.profile} • same construction lineage • unreviewed • same physical scale",
        fontsize=16,
    )
    figure.tight_layout()
    output = Path("artifacts/review")
    output.mkdir(parents=True, exist_ok=True)
    filename = (
        "variation-gallery.png"
        if args.profile == "adult_design_v1"
        else "control-stress-gallery.png"
    )
    figure.savefig(output / filename, dpi=160)
    plt.close(figure)
    print(output / filename)


if __name__ == "__main__":
    main()
