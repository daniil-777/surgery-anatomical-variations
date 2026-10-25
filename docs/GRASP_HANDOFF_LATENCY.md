# Faster handoff and a more visible grasp

Both automatic camera/grasp and local visual-action tasks share `AutomaticGrasp`.
Previously each camera arrival was followed by 17 serial physics rollouts and a
32 mm tool approach. The model's neural inference was not the main delay.

The bundled UCB option is now revalidated on the actual contact, material values,
attachments and response parameters at 0.8, 1.0 and 1.2 stiffness. These three
fresh solver rollouts run in a worker during the visible tool approach. The
instrument waits 2 mm outside tissue until validation passes. Failed validation
falls back to full option learning; failed checks or cancellation release the
tool. An exact-input, four-entry cache avoids repeat checks on unchanged inputs;
contact selection and complete instrument sweeps are still checked every time.

The initial approach is 12 mm, with the existing 12 mm/s peak speed limit.
Closure, lifting, lowering and release remain continuous. Collision margins,
camera/lens clearance, 0.8 N reaction-force, 5 mm displacement, 0.35 gradient and
2 mm attachment-lag budgets are unchanged. These are simulation budgets, not
validated tissue-damage thresholds.

## More visible tissue motion

The v2 reward targets 3.2 mm of actual tissue displacement instead of 1.5 mm.
Retraining selects the existing 4 mm lift option, with a 3 second smooth ramp
(2.5 mm/s peak, below the 3 mm/s budget). The original 2 and 3 mm options remain
available for new tissue assignments. No forces are multiplied and no solver
or rendering deformation is faked.

The saved training input gives 3.17 mm hold displacement, 0.166 N peak force and
0.076 mm residual after the isolated release rollout. All three held-out checks
pass. `node scripts/train_grasp_default.mjs` reproduces the bundled action values;
the replay test checks their numerical agreement. The recorded input and its
hash accompany the weights. Source Q values and baseline results describe the
original training scene; current-scene revalidation is identified separately.

## Verification

The release checks cover the actual browser task sequences, disease variations,
cancellation during mapping/validation/lifting, changed geometry, mobile stop
controls, stale visual actions, lost inference during holding, tissue recovery,
instrument collision and camera clearance. Timing is recorded from the end of
camera playback to visible instrument motion and first tissue contact, sampled
every 25 ms. Local Mac timing is device dependent; slow validation pauses the
instrument outside tissue instead of bypassing checks.

The unchanged release measured 9.75 seconds (camera/RL) and 11.39 seconds (local
visual policy) from camera arrival to visible tool motion. With the stronger
grasp, complete baseline runs measured 0.28 seconds and 0.79 seconds respectively;
first tissue contact followed at 2.42 seconds and 2.96 seconds. The full rendered
RL sequence held 3.17 mm tissue displacement and recovered to 0.0046 mm, with
0.167 N peak reaction force. Per-run JSON studies,
screenshots, timing traces and the release receipt are stored in the local
`artifacts/grasp-handoff-2026-10-25/` review.

This release contains grasp behavior only. The login/front-page redesign remains
local, pending its separate deployment decision.
