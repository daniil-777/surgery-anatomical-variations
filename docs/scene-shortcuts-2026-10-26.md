# VirtaMed scene shortcuts

A sticky row at the top of the right controls panel opens joint shape/texture variation, camera/grasping actions, and disease text/hints. Custom tissue-contour, grasper, and nodular-tissue icons distinguish the three destinations. The row stays inside the panel and uses the existing scene-controls entry on phones.

A jump reveals the Scene controls tab if necessary, scrolls the controls immediately, and focuses the destination for keyboard users. Desktop navigation scrolls only the right panel. Mobile navigation accounts for the sticky row's measured height; text scaling and reduced motion are supported. Navigation does not generate anatomy, change the camera, or start a task. Existing generation and action buttons retain their behavior.

Validation: TypeScript; five shortcut browser tests at 375/768/1440 px, keyboard and 150% text; five existing scene-editor tests; three VLA tests, including a real look/grasp/release sequence and stop/cancellation cases. The pre-existing microphone test was skipped because no prerecorded speech fixture was supplied. All 13 executed browser checks passed. The navigation row had zero axe-core 4.10.3 violations/incomplete checks at the three widths. Measured click-handler-to-destination-focus latency was 0.4–4.4 ms; this is not a page-wide INP measurement.

Reproduce shortcut checks with `MODEL_NAMES_URL=http://127.0.0.1:5191/ SCENE_SHORTCUT_OUTPUT=artifacts/scene-shortcuts/browser node node_modules/@playwright/test/cli.js test --config playwright.scene-shortcuts.config.ts`. Before/after captures, accessibility results, source backups and live verification are in `artifacts/scene-shortcuts-2026-10-26`.
