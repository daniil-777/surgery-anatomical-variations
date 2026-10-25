# Camera approach and gentle liver grasp

## Scope and research decision

The feature composes the existing learned organ-conditioned camera path with a separately learned, bounded grasp option. The stage supervisor, geometric grasp-point search, and motion interpolation are authored. This is **not** an end-to-end visual-action model or a learned multitask supervisor. The user sees the camera approach, instrument insertion, gradual jaw closure, small lift, hold, lowering, opening, withdrawal, and tissue recovery.

The [options framework (Sutton, Precup & Singh, 1999)](https://www.sciencedirect.com/science/article/pii/S0004370299000521) motivates composing temporally extended actions with explicit initiation and termination conditions. Here the camera option must actually complete before the grasp option can start; cancellation invalidates pending work at either stage.

[LapGym (Scheikl et al., JMLR 2023)](https://www.jmlr.org/papers/v24/23-0207.html) provides surgical RL tasks with deformable tissue and sequential grasp/lift interactions. Its discussion of multiphase credit assignment and reward hacking supports separating the initial task into measurable stages. We reuse Viscera's current solver instead of claiming equivalence to LapGym's SOFA simulation or importing its benchmark results.

[SRT-H (Kim et al., 2025)](https://arxiv.org/abs/2505.10251) separates surgical task selection from language-conditioned trajectory generation and uses corrective instructions. It is imitation learning, not evidence that browser RL alone produces comparable surgical competence. [SRT (2024)](https://arxiv.org/abs/2407.12998) also motivates relative action representations: future visual policies here should predict bounded camera/tool increments, not uncalibrated absolute robot poses.

## Implemented learning contract

Camera: unchanged Dyna Double Q, 10,000 episodes on a fresh RGBD map; every reachable starting view must pass the existing arrival/route-efficiency audit. The camera is fixed during instrument execution.

Grasp: a one-step episodic bandit selects among three trajectory options (2/3/4 mm target lift, 2.5/3/4 s ramp, 1.5 s hold, symmetric lowering). [UCB exploration](https://doi.org/10.1023/A:1013689704352) balances testing all options and refining promising ones; our exploration coefficient is an engineering choice, not a claim of the paper's regret bound under this reward scaling.

Each of 12 training episodes runs the actual `WholeScenePhysics` solver, including all current organs, authored attachment components, learned synthetic SLS materials, local compliance, and nonlinear response. A seeded uniform multiplier in [0.85, 1.15] varies material stiffness. No mesh mutation, training force, or exploratory action reaches the displayed scene. A Web Worker keeps rollouts off the render thread; stopping terminates it.

Reward is `5 - abs(heldDisplacementMm - 1.5) - 2*peakReactionN - 0.025*trajectorySeconds`, or -5 if execution/recovery criteria fail. Frozen evaluation uses stiffness multipliers 0.8, 1.0, and 1.2. All three must pass. Nominal evaluations of the other two options give an exact uniform-choice expected-reward baseline; the selected policy must meet or exceed it. These are local robustness checks on the same scene/contact, **not** unseen-anatomy or patient validation.

The study export includes all material assignments, organ bounds, response parameters, attachment edges, triangle/barycentric contact, seed, action values, visits, 12 trials, 5 distinct evaluation/baseline rollouts, chosen option, and executed telemetry. `trainGraspPolicy(study.grasp.trainingInput, study.grasp.policy.seed)` reproduces the learned values; elapsed timing is hardware-dependent.

## Geometry, control, and limits

Only ray-visible liver triangles are candidates. The full current instrument/camera guard checks candidate approaches, a 32 mm insertion, maximum 4 mm traction, and 21 jaw-closure samples. An additional 1.2 mm planning margin covers the less-than-0.42 mm jaw-tip arc between closure samples and small tissue motion. The live metal-envelope checks remain active; a failed check releases the attachment. Geometry edits, physics reassignment and manual instrument control stop the task; appearance-only edits invalidate camera maps without changing tissue mechanics. Generated surrounding tissue participates in instrument occlusion/collision, and the stationary lens is rechecked against the refitted current tissue surfaces.

Quintic interpolation gives zero endpoint velocity/acceleration, a maximum insertion/withdrawal speed of 12 mm/s, and target traction below 3 mm/s. Per-frame checks stop on reaction above 0.8 N, displacement above 5 mm, displacement-gradient bound above 0.35, attachment lag above 2 mm, solver clamping, or non-finite output. Successful completion requires at least 0.5 mm held displacement and less than 0.2 mm residual after release. These are conservative **authored simulator budgets**, not clinical injury thresholds or measured jaw pressure.

Existing limitations remain: attachment-based grasping rather than resolved opposing-jaw friction/pressure, synthetic material estimates, inferred scale/supports, no tissue failure or organ-organ collision, and no calibrated robot/trocar kinematics. The attached distal tissue patch is excluded from distal-metal collision checks by the existing instrument model. Do not present this demonstration as a validated surgical technique or autonomous clinical system.

## Three proposed visual-action experiments

1. Distill successful RGBD camera trajectories into a small image-conditioned policy and compare arrival, clearance, and route length on held-out lighting and disease seeds, following the RL-to-visual-policy principle in [RLDG](https://generalist-distillation.github.io/).
2. Train a short-horizon relative-action policy for visible liver contact, gentle lift, and release using simulator demonstrations, testing force, visibility, recovery, and perturbation failures against the existing guarded controller, inspired by [SRT](https://arxiv.org/abs/2407.12998).
3. Fine-tune a compact language-conditioned VLA on “look at liver”, “grasp”, and “release” with asynchronous action chunks and the same runtime guards, using [SmolVLA](https://huggingface.co/blog/smolvla) as a practical starting point.

These are proposals, not models installed or trained by this feature. SmolVLA's official release describes a 450M-parameter model and asynchronous inference; its household-robot pretraining does not supply surgical action grounding. Start with local GPU/server inference and a bounded browser action bridge, and measure latency and task accuracy before attempting browser inference. [OpenVLA-OFT](https://openvla-oft.github.io/) supports action chunking and efficient adaptation, but its documented memory/compute requirements make it a less convenient first experiment. [Octo](https://octo-models.github.io/) is another primary-source generalist-policy baseline for goal-image conditioning and adaptation to new action spaces.

## Validation and release

Run focused unit tests for grasp learning, execution guards, existing tools, camera planner, and saved camera weights; then browser tests of actual camera/tool/physics progression, interruption, disease variations, and mobile controls. Inspect phase screenshots and a temporal recording, retain failures as regression evidence, build the static release, and verify the deployed assets and live task. The deployment uses the existing Pages workflow. Rollback target is commit `3099195e7b01963c2b0b1feceba4fb1e7a8b27fb` and its unchanged camera artifact; a new rollback commit can restore only this feature's source files without disturbing unrelated work.
