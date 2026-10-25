# Pretrained scope demonstrations and organ-conditioned approaches

Date: 2026-10-25. Simulation-only evaluation on the authored VirtaMed scene.

## Research and implementation choice

[Schaul et al., Universal Value Function Approximators, ICML 2015](https://proceedings.mlr.press/v37/schaul15.html) formalizes value functions conditioned on goals. Here the goal is an organ inspection pose, not simply an organ ID appearing in the frame. We use a separate finite Double-Q table for the selected goal; we do not claim a neural UVFA or generalization to unseen goals.

[Li et al., ILLC, ICRA 2022](https://arxiv.org/abs/2204.03195) combines reconstructed surgical scenes, RGBD rendering and reinforcement/imitation learning for laparoscope control. Its learned demonstration prior and cross-scene experiments are not reproduced here. Our RGBD views are rendered from the current authored scene, and semantic IDs come from that known map.

[Andrychowicz et al., Hindsight Experience Replay, 2017/2018](https://arxiv.org/abs/1707.01495) addresses sparse goal rewards by relabeling experience. For our small, fully observed, at-most-45-node transition graph, eight Dyna updates per real transition already provide inexpensive replay. We retain the existing Dyna Double-Q implementation instead of introducing a neural network, replay infrastructure and unstable browser optimization. Hindsight replay is a possible extension for much larger, partially observed workspaces; it is not claimed as implemented.

## Saved weights and provenance

`apps/studio/public/camera-policies/virtamed-survey-v1.json` contains real learned weights, the compact recorded feature graph, learner/source/weight SHA-256 digests, training curve and reserved-start evaluations. It is approximately 84 kB. Reproduce it with:

```
node scripts/train_default_camera_policy.mjs
```

The generator can also accept a complete browser Export study as its input. It trains from zero with seed 42, 6,000 episodes and the steady-motion reward, producing 87,903 TD updates (including eight Dyna updates per experience). The demonstration begins from reserved start 3 and follows learned actions 3 → 6 → 14 → 23. The approach to that start and the recurring return are explicitly labeled guarded returns, not learned actions. The start choice demonstrates angular and insertion movements; it is not an independent evaluation sample.

Clicking Start camera demonstration prepares the operative view, captures fresh RGBD and rebuilds collision-checked edges. Transfer requires the same anatomy/material signature, graph/action/target identities, pose lattice, inspection masks and port/FOV. Small render differences are allowed (depth quantiles within 0.5 mm; normalized features/quality within 0.05); clearances must match within 0.05 mm. Frozen weights are re-evaluated against the fresh graph. No retraining or heuristic substitution occurs. Edited anatomy is rejected with the edits intact; it can use current-scene training instead.

## Continuous movement

Continuous inspection is on by default. After each learned inspection episode, a shortest-edge-count return through the fresh guarded graph leads to the next episode. Pose, cumulative elapsed time and entry pivot are continuous across cycle boundaries. Path storage is bounded; it does not append an endless trajectory. Pause, Stop, Escape, manual camera input, scene invalidation and context loss retain their stop behavior.

RCM interpolation uses one inferred fixed entry point, axial insertion and spherical angular interpolation. Quintic easing has zero endpoint velocity and acceleration. Its 1.875 peak derivative is included in timing, retaining 24 mm/s and 18 degrees/s maximum movement rates. The graph checks curved edges with sampled swept spheres and a curvature margin. Playback checks every displacement with a 2.01 mm virtual lens sphere. A new obstruction stops movement before the surface. No collision-free guarantee is made for unknown geometry, a physical camera shaft or a real trocar.

A DOM/SVG overview shows the scope, light direction, pivot, planned inspection and guarded return. It never enters RGBD captures or the anatomy collision mesh. The main viewport is the moving first-person image.

## Organ-conditioned approach

Go to liver and Go to gallbladder preserve the current camera pose. They reuse the existing inferred pivot when the pose is still consistent with it. Otherwise a local pivot is inferred from the current optical axis. A bounded 3 × 3 × 5 angular/insertion graph points toward the selected organ's current world-space bounds. It includes a retreat plane, allowing withdrawal before changing target. Occluded or disconnected candidate poses are removed by the same geometry guard.

The target pose is selected from actual semantic RGBD pixels. A candidate must have at least 0.8% target area, less than 90% target area, centroid error at most 0.55 in normalized image coordinates, target mean depth at least 30 mm and lens clearance at least 10 mm. The score is:

- 0.35 × centering quality;
- 0.25 × exp(-abs(log(area / desired area))), desired area 0.45 for liver and 0.22 for gallbladder;
- 0.30 × exp(-abs(target depth - 65 mm) / 95 mm);
- 0.10 × existing RGBD image quality.

These are transparent simulation tuning parameters, not clinically calibrated working-distance recommendations. The best qualifying pose becomes the single terminal goal; other poses retain zero arrival mask even when the organ is visible. A current pose within 0.015 score of the best is held without gratuitous movement. The organ condition and goal node form part of the policy fingerprint.

Each approach trains for 10,000 episodes with the steady-motion reward in the existing Worker. Before motion, every graph start is evaluated: all must reach the goal, and no learned route may exceed 1.8 times the shortest-distance graph baseline. Dijkstra is used only for this audit; its route never replaces the RL route. Reserved-start results remain separately visible. The approach stops and holds the inspection view; the endless survey remains a separate operation.

Approach capture uses the existing interior-camera inverse-square light compensation law, based on the first surface along the optical ray (22–240 mm bound, intensity = distance² × 3.4). Playback smoothly interpolates these captured light intensities with the same pose easing. This prevents the fixed long-distance lamp power washing out close tissue. It is a synthetic light-control model, not calibrated endoscope automatic exposure.

## Validation scope

Tests cover deterministic weight reproduction, artifact/scene mismatch rejection, target-specific policy actions, all-start reachability, multiple training seeds, a 50-cycle replay, loop boundaries, newly obstructed returns, curved-path collision checks, target switching with a retained pivot, RGBD occlusion, actual browser motion, mobile controls and cancellation. Browser receipts record actual camera trajectories and check speed, angular rate and pivot residual, as well as anatomy signatures and runtime errors. Visual review includes approach, arrival and looping screenshots.

The planner is a finite-map training aid. It does not learn anatomy from patient images, certify surgical camera technique, model shaft/port forces, or establish clinical validity. The saved survey reaches liver and gallbladder; the local survey map does not claim an inspection of ducts or artery that are not sufficiently framed.
