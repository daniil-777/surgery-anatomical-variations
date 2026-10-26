# Organ prompt feedback and scene access

`Load Text` previously marked a prompt as “Applied to 3D Organ” before generation.
The same label could appear immediately after clicking Apply, even if compilation
later rejected the instruction. The repaired interface records the actual
successful prompt after generation commits. Loading or editing text shows a
ready-to-apply instruction; loading keeps the current model, and rejected
instructions preserve it. Other generation actions clear stale prompt success.

Organ studio now has a direct **VirtaMed scene** workspace tab. It opens
`?mode=scene&scene=virtamed`, where the existing **Joint variation**, **Actions**,
and **Disease** icons remain at the top of the controls panel.

The existing login-protected host was updated with hashed frontend assets before
atomically replacing its HTML entry points. Previous HTML and all existing
assets were retained for rollback. No credentials or session rules changed.

Verification: 11 browser checks passed against the isolated candidate and again
on the public host. These cover desktop/mobile prompt application and navigation,
all 28 built-in organ examples, learned shape/joint/material sampling, disease,
VirtaMed textures/physics, and scene/fat/tissue/texture/procedural workspace loading.
A further regression check held the compiler request to verify that the pending
state never claims success. The original Load Text status failure was reproduced
on the previous deployment. Production build and rendered evidence checks passed.

A fresh authenticated session did not reproduce a generation failure for the 28
built-in examples before the feedback repair either. A different failing command
or browser state requires its exact error and reproduction steps; this change
must not be described as a repair to the compiler itself.

The host continues to serve the browser build. Services requiring the Python API,
including textured organ GLB/Unity export and trained text-adapter inference,
remain unavailable as in the prior static GitHub Pages build. They are separate
from the browser text compiler and the tested browser samplers.

Local evidence: `artifacts/studio-restoration-2026-10-26/`. The permanent prompt
regression is `tests/e2e/atlas-prompt-application.spec.ts`; the local authenticated
runner creates an isolated temporary QA session and revokes it after checking.
