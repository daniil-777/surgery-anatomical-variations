# Text and voice edits in existing scenes

The VirtaMed scene and Import 3D now expose **Anatomy with words** near the top of their controls. Choose an edit target, click a disease hint, type and press Enter/Apply text, or use the existing microphone button. Shift+Enter inserts a newline. Hints apply immediately. The microphone uses the same local speech engine as the organ studio.

The adapter calls the existing `compileTextLocally` anatomy compiler and transfers its bounded controls onto the existing mesh. It does not generate replacement anatomy. The older concise upload syntax remains supported. Disease hints are generated from the supported profile library. Explicit units and percentages are rejected because the atlas dimension solver measures atlas references, not uploaded meshes.

VirtaMed supports the existing five liver/gallbladder disease profiles, their severity, seven shape controls and tissue finish. Text automatically enables tissue appearance. All connected surfaces use the same continuous rest-coordinate deformation; transition materials inherit adjacent tissue controls. A new target replaces the scene's active disease study. Custom lesion placement, count, distribution and contrast remain available only in the organ/import editors; the connected scene rejects those edits. Replay/joint variation and Restore video geometry exit the text recipe. Existing physics bindings are rebuilt by the scene's normal geometry-change path.

Import 3D accepts every supported static GLB/glTF/OBJ/STL upload. On multipart scenes, the text target is explicit; reference assignments can be corrected in the existing organ panel. A target's first text recipe starts from the immutable upload; subsequent text instructions amend that recipe. Other meshes retain their current geometry and materials. Preparation occurs off-scene and commits atomically; cancel/reset/replacement invalidate pending work. GLB export includes current edits. Recipe export includes source hashes, target assignments, preceding sampled variation and per-target text overrides. Generic uploads do not acquire inferred anatomical attachments or a collision solver from text editing.

Text editing uses the recipe's full bounded values for both shape and appearance; the sampling strength sliders control Generate variation. Restore original reinstates the exact source resources. These remain illustrative visual disease profiles, not patient-specific or clinically validated disease simulations.

Validation:

- `node node_modules/vitest/vitest.mjs run apps/studio/src/sceneTextEdits.test.ts apps/studio/src/imports/variations.test.ts apps/studio/src/virtaMedScene.test.ts apps/studio/src/virtaMedInterfaces.test.ts apps/studio/src/virtaMedBiliary.test.ts`
- `node node_modules/@playwright/test/cli.js test --config playwright.scene-text.config.ts`
- Set `SCENE_VOICE_AUDIO` to a 16 kHz mono WAV to exercise the real speech engine with prerecorded audio; this test intentionally skips without a fixture and never records a person.
- Existing `playwright.imports.config.ts`, `playwright.virtamed.config.ts` and public-copy smoke checks cover upload/export, recorder, scene lighting, navigation and instrument regressions.

The per-scene texture-count ceiling is 128 maps; the existing 32-megapixel decoded-image budget is unchanged. This accommodates three 512² channels across the 39-part torso. Targeted text edits check the combined scene budget before committing.
