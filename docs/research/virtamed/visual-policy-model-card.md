# Visual Policy 1: local liver-task skill selection

UI dictionary: **Visual Policy 1 → SmolVLA (`lerobot/smolvla_base`) with a Viscera low-rank action-expert adapter**. The research/model name stays in this technical record; the product UI uses the general name.

## What the model controls

The input is a 256 × 256 letterboxed RGB render, a supported task instruction, and 16 observed state values: normalized camera position/direction, instrument engagement and jaw state, measured simulator displacement/reaction, and previous executed skill. Teacher labels, phase names, elapsed phase time, segmentation, organ identity masks, and desired future actions are not model inputs.

The five output coordinates represent `look`, `grasp`, `release`, `finish`, and `wait`. SmolVLA predicts them with its flow-matching action expert and a deterministic five-step sampler. This is **learned visual skill selection**, not a learned continuous camera/instrument trajectory or an end-to-end surgical robot controller. The model chooses each skill from a fresh observation. The precondition checker rejects an out-of-order choice; it does not substitute the expected scripted choice. Supported instructions describe the same complete liver task. Arbitrary instructions and other organs are not supported.

`look` invokes the existing goal-conditioned RGBD camera learner and its all-start route audit. `grasp` invokes the existing isolated coupled-physics option learner, geometric contact search, and instrument controller, then holds for a separate decision. `release` lowers, opens, withdraws, and verifies recovery. The completed outcome must be confirmed by the physics controller before `finish` is accepted.

## Why this interface

[SmolVLA's official documentation](https://huggingface.co/docs/lerobot/smolvla) requires task-specific demonstrations and gives roughly 50 demonstrations as a starting point, not a sufficiency guarantee. Its pretrained arm actions have no direct correspondence to this simulator. A discrete skill interface is a deliberately narrower first adaptation, allowing the existing simulator controllers to retain their independently checked motion and tissue-response behavior. [SRT-H](https://arxiv.org/abs/2505.10251) provides a research motivation for separating task-level decisions from low-level execution; this implementation does not reproduce that paper or inherit its reported results.

[The official architecture](https://huggingface.co/blog/smolvla) combines images, language and proprioception with an action expert. We retain that architecture, freeze its visual-language backbone, adapt the action expert's query/value projections with rank-eight residual adapters, and train the state/action/time projections. There are 1,957,712 trainable parameters. Image-encoder outputs are cached during training only because that encoder is frozen; the full image encoder executes during inference. The base checkpoint is loaded strictly before adapters are installed.

## Data and evaluation contract

`scripts/collect_visual_policy.mjs` records rendered images at the initial view, inspected liver, held grasp and released/recovered tissue. Three temporal frames are saved at each boundary, but only the first is used in training/evaluation. Identical geometry signatures are grouped before splitting so repeated anatomy cannot leak across train/validation/test. Failed teacher executions are retained as failure evidence, not relabelled as successful demonstrations.

Training additionally includes explicitly labelled black-feed corruption examples, with otherwise unchanged state, to teach `wait`. These are synthetic negatives, not real surgical images. Two supported instruction phrasings are used for training; evaluation also includes the third UI phrasing. Real simulator images are the visual input; this is not patient-video training or clinical validation.

Checkpoint selection uses validation skill accuracy and action-margin coverage only. The final test partition is evaluated after selecting the checkpoint. Promotion requires at least 12 training, three validation and five test episodes, at least 98% test decision accuracy, 95% action-margin coverage, zero accepted incorrect test actions, and warm p95 inference below 1,500 ms. These are engineering gates for this narrow simulator task, not a guarantee on other anatomies. Scores are flow-matching coordinates, not calibrated probabilities. The runtime abstains when the top-two margin is below 0.5 or outputs are invalid.

The generated `manifest.json` records exact checkpoint hashes, revisions, splits, predictions, learning curve and measured latency. A short development pilot is distinct from the promoted checkpoint. Browser evaluation must additionally execute the real service through complete camera/grasp/release tasks and test interruption and service failure.

## Measured release results — 25 October 2026

The released adapter is `visual-policy-1-b91146273aef`, SHA-256 `b91146273aef956658f7630a7ad64c204dc1e5bc05bbc129e53f04b76eab10b9`. An 800-step run used 22 training episodes, three validation episodes and five frozen test episodes; validation selected step 400. The run took 436 seconds on this Mac's M3 Pro, including periodic validation. The earlier 100-step pilot did not meet the coverage gate and was not released.

The frozen test achieved 100% skill accuracy, 100% acceptance coverage and zero accepted incorrect decisions. Its 80 evaluations comprise 20 actual rendered boundary images from five episodes, three instruction phrasings per image, and 20 black-feed negatives. A further six unseen geometry groups, recorded after the training-data snapshot, also achieved 100% accuracy and coverage across 96 evaluations. Repeated instructions and corrupted images are not independent anatomical cases. These small, related simulator sets do not establish general visual understanding or clinical performance; previous-skill state strongly constrains this fixed sequence.

Warm end-to-end model inference on the M3 Pro measured 290 ms median, 375 ms p95 and 381 ms p99. All four real-service browser tasks completed, covering baseline anatomy and three liver shape/appearance variations. Eight visual-policy browser scenarios passed in total, including rejection of an out-of-order action, cancellation of an outstanding request, connection loss during a held grasp, and a mobile Stop control. All 13 camera-planning and six automatic-grasp browser regressions passed, along with 68 focused TypeScript tests, nine Python tests, type checking and Python lint checks. The browser tasks verify actual instrument release, finite physics, peak simulated reaction below 0.8 N and recovery below 0.2 mm; these are simulator measurements, not validated surgical force limits.

## Runtime boundaries

GitHub Pages serves the interface; the Python model runs on the user's Mac at `127.0.0.1:8877`. No images are sent to an external inference provider. The loopback service permits only localhost and the existing deployed site origin, validates image dimensions/body size/state/instruction, checks artifact hashes, warms the model before listening, and allows one inference at a time with no queue.

Each browser request has an identity, cancellation signal and seven-second deadline. The browser verifies model identity and scene/camera consistency before applying an action. Model errors, ambiguous/out-of-order actions, scene changes and disconnection stop the task. Escape and the visible Stop control remain active. A held grasp has a 15-second decision timeout; force, displacement, attachment, instrument-envelope and camera-clearance checks continue every frame. The simulator still does not resolve clinical jaw pressure, friction, tissue injury, or real robot mechanics.

The physics handover waits for actual tool readiness rather than assuming two render frames are sufficient. Scene comparison uses geometry/material/visibility and physical camera pose/projection, excluding changing navigation-status text; positions are compared at one-millionth of a millimetre precision to ignore numerical round-off.

## Reproduce

Use Python 3.11 and the pinned Mac runtime in `deploy/visual-policy-requirements.lock`:

```sh
uv venv --python 3.11 artifacts/visual-policy-1/runtime
uv pip install --python artifacts/visual-policy-1/runtime/bin/python -r deploy/visual-policy-requirements.lock
artifacts/visual-policy-1/runtime/bin/python scripts/setup_visual_policy_models.py --root artifacts/visual-policy-1
artifacts/visual-policy-1/runtime/bin/python scripts/visual_policy_server.py --models artifacts/visual-policy-1/models --run artifacts/visual-policy-1/trained
```

Open the deployed VirtaMed scene, select **Connect local policy**, then **Run visual liver task**. The supported command is shown in the instruction selector. **Export visual task study** saves actual model decisions, inference/round-trip latency and final simulator evidence.

On the first connection, allow the browser's **Apps on this device** / local-network permission for this site. If it was previously denied, change that permission in the browser's site settings and connect again. [Chrome requires this permission for public pages connecting to loopback services](https://developer.chrome.com/blog/local-network-access); CORS headers alone cannot grant it. The connection UI allows 30 seconds for the prompt and explains denial without enabling execution. Published-site browser tests grant permission only in disposable test contexts and separately check the real denied-permission behavior; no browser security feature is disabled.

To regenerate demonstrations, serve the static build and set `MODEL_NAMES_URL`, `VLA_DATA`, `START`, `EPISODES` and optional `CONCURRENCY` (bounded to two) before running `node scripts/collect_visual_policy.mjs`. Run `scripts/train_visual_policy.py --models <pinned-model-root> --data <recordings> --out <new-run> --steps 800`; the output directory must be new. Keep the raw recordings and generated dataset manifest alongside the trained run. The adapter is stored as safetensors, not executable pickle.

## Sources, licence and rollback

Base checkpoint: [lerobot/smolvla_base](https://huggingface.co/lerobot/smolvla_base), revision `5e8d12a6e2975b0e5e5fce7c8caf47c371d257b6`, Apache-2.0. Processor/config: [SmolVLM2-500M-Video-Instruct](https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct), revision `7b375e1b73b11138ff12fe22c8f2822d8fe03467`. Training/runtime uses [LeRobot 0.4.4](https://github.com/huggingface/lerobot/tree/v0.4.4), with the exact resolved dependency lock in the repository. Existing simulator anatomy/texture attributions remain applicable to the synthetic recordings.

Stop the local service or disconnect it to disable visual-policy inference. The existing **Approach & grasp liver** controller remains available independently. The previous release is `abf4ae81696c0a2f179896d70739fdf0d5b505de`; no physics solver or camera-learner weights are replaced by this feature.
