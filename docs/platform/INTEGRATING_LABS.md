# Integrating a lab with the account platform

For lab owners (Tissue, Fat, Blood, Cutting, Imports, Recording, and future labs). The platform saves, versions,
thumbnails and exports a lab's work only when the lab opts in; standalone use (`?mode=…`, `tissues.html`, `fat.html`,
the public copy, every existing e2e suite) is unchanged whether or not a lab adopts this.

## How a lab is hosted

The account shell opens a lab in a same-origin iframe: `./?mode=<mode>&embed=1&lab=<labId>` (or `<page>.html?embed=1`).
The lab boots exactly as today through `src/boot.ts` → `src/main.tsx`; nothing platform-specific is loaded into the lab
document except the tiny registry below. The shell draws a 44 px project bar above the iframe (title, save status,
Version History, Add to Library, Record, account) and talks to the lab only through
`apps/studio/src/platform/bridge/labSession.ts`.

## The contract (`platform/bridge/labSession.ts`)

```ts
const session = registerLabSession({
  labId: "tissue",                 // registry id
  title: "Tissue Lab",
  serialize: () => ({ schema: "viscera.tissue-session/1", labId: "tissue", state, attachments, versions }),
  restore: async (document, signal) => ({ exact: true, warnings: [] }),
  busy: () => (recording ? "recording" : false),
  thumbnail: async (width, height) => blobOrNull,            // optional
  recordingCanvas: () => canvasElement,                       // optional (default: largest visible canvas)
  exports: () => [{ id: "material", label: "Add material to Library", kind: "material", run: async (signal) => item }],
  describe: () => ({ title: "Liver capsule · variation 42" }),
});
session.changed("document");   // saved state changed (may create a version)
session.changed("view");       // camera/panels only (autosaved, never a version on its own)
session.dispose();             // on unmount
```

What the platform guarantees:
- `restore()` is called only on a **freshly loaded** lab, before the user interacts: the shell reloads the iframe
  before applying any version. An adapter never has to cancel half-finished work.
- `serialize()` and `thumbnail()` are never called while `busy()` is truthy or while any
  `canvas[data-scene-recording-active="true"]` exists (one GPU job at a time).
- Attachments are stored byte-exact, content-addressed by SHA-256, and handed back unchanged. Re-validate them with the
  lab's own importers (e.g. `importTissuePbrBundle`); never bypass validation.
- `claims.evidence`, `claims.limitations` and `claims.rights` are shown verbatim. The platform never labels anything
  validated, measured, learned, realistic or approved.

What a lab promises:
- `state` is JSON-safe. Integers above 2^53 (uint64 seeds) are **decimal strings**; JSON numbers would round them.
- Attachment names match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; total size stays within the account's file limit
  (50 MB per file on the free plan).
- Transient state (playing, hover, in-flight requests) is normalised away inside `serialize()`, so an unchanged lab
  produces an identical document (the platform skips saves whose canonical hash did not change).
- Honesty strings in `exports()` are copied from the lab's own manifests and notes, not rewritten.
- Nothing from the lab is uploaded unless the user saves or adds to the library. Where a lab's UI promises "files stay on
  this device", keep that copy for standalone use; inside the shell the user's explicit save is the opt-in.

## Adopting it, step by step

1. **Adapter module in your lab folder** (pure, unit-testable), e.g. `src/tissues/sessionAdapter.ts`:
   `createTissueSessionAdapter({ latest, pendingControls, viewport, setters… }): LabSessionAdapter`.
   Import only types and `registerLabSession` from `../platform/bridge/labSession` — it has no runtime dependencies,
   so it does not pull React, three.js or Supabase into your typecheck graph (e.g. `tsconfig.tissues.json`).
2. **Register while mounted** in the lab component:
   ```tsx
   const latest = useRef(currentState); latest.current = currentState;
   const session = useRef<LabSessionHandle | null>(null);
   useEffect(() => {
     const handle = registerLabSession(createTissueSessionAdapter({ latest, /* setters */ }));
     session.current = handle;
     return () => handle.dispose();
   }, []);
   useEffect(() => session.current?.changed("document"), [/* every persisted value */]);
   ```
   Registering is cheap and harmless standalone (nobody listens), so it needs no `isEmbeddedInPlatform()` guard; use
   that helper only to hide chrome that makes no sense inside the shell.
3. **Restore ordering.** Apply saved controls *after* the lab's own loads finish (catalog/manifest/bundle), because many
   labs overwrite controls with recipe defaults on load. Keep a `pendingControls` ref that the load handler consumes.
4. **busy()** returns a reason while loading, importing, baking, running a simulation or recording.
5. **thumbnail(width, height)** — prefer the scene-recording registry's `prepare({width, height, fps: 1, signal})`, draw
   the canvas into a 2D canvas in the same task, then `restore()`; this works with `preserveDrawingBuffer: false`. Without
   a `thumbnail`, the shell captures the largest visible canvas itself (fine for canvases with a preserved buffer).
6. **exports()** — one entry per library item kind the lab can produce (`shape`, `material`, `texture`, `recording`,
   `scene`, `image`, `model`), each returning files with roles (`mesh`, `albedo`, `normal`, `roughness`, `height`, `data`,
   `spec`, `video`, …), an optional thumbnail, metadata and claims.
7. **Register the lab in the shell**: add an entry to `apps/studio/src/platform/core/labs/registry.ts` (id, mode/page,
   title, lucide icon, category, `supportsProjects: true`). That is the only shell-side change.
8. **Tests**: a node test that serializes, round-trips through `JSON.stringify/parse` (attachments as Blobs) and restores;
   one Playwright spec in `tests/platform/` that opens the lab in the shell, saves a version and restores it.

## Per-lab notes from the code survey (2026-10-21)

**Tissue Lab** (`tissues/TissueLab.tsx`, ~30 lines to adopt). Schema `viscera.tissue-session/1`. State: source
`{kind: "library", catalogId, resolution, manifestSha256}` or `{kind: "pbr-bundle", bundleSha256, filename}`, controls
with `playing: false`, `materialVariation.seed` as a decimal string, learned appearance `{modelId, condition, seed,
resolution} | null`. Attachments: `pbr` = the original `.tissue-pbr.json` text bytes (restore through
`importTissuePbrBundle`), `model` = the `.tissue-model.json` bytes when a learned model is active. Restore: refuse while
recording/pbrBusy; set `pendingControls`, select library entry or import the bundle, then apply controls after the
manifest load (`TissueLab.tsx` :95/:139 overwrite order); camera is "not restored" until `TissueViewportHandle` gains
pose get/set. Export kind `material`: display recipe (verbatim `serializeDisplayRecipe` output and its note), thumbnail,
optional 4K still/clip, library reference by SHA-256 instead of re-uploading native maps, the flag "variation applied at
display time; downloadable maps are unvaried".

**Fat Lab** (`fat/FatLab.tsx`). Everything regenerates from the recipe (uint32 seeds as numbers are safe). Restore: set
`shearKpa` after `preset`; apply `frame` after the `[run]` effect. Export `shape`: geometry GLB + colour/height/roughness
PNGs + recipe JSON + thumbnail; label that the GLB alone is not a complete PBR asset (the triplanar shader is viewer-only).
Note: `fat/` files are SHA-256-locked by the tissue session's isolation receipt — coordinate before editing.

**Blood Lab** (`blood/*Lab.tsx`). Register per workspace (`blood-surface`, `blood-pool`, …; ids match `^[a-z][a-z0-9-]{1,31}$`). v1 restores settings and
restarts the simulation (`exact: false`, warning "simulation restarted from its initial state"). Export `recording`: the
recorder video + the workspace's evidence JSON unchanged (including `limitations`).

**Cutting** (scissors/scalpel, inside the physics dialog). v1: pose/settings with `exact: false` ("incisions are not
restorable yet"); export `shape` built from `snapshot().surface.geometry` with the CC-BY attribution from
`public/cutting/NOTICE.txt`.

**Imports studio** (`imports/ImportedModelStudio.tsx`). The shell's Imports space has its own pipeline
(`platform/core/imports`, wider formats incl. FBX/PLY/USDZ and source-app detection). Interop later: props
`{initialFiles?, onExportGLB?, onRecipe?}` so a library/import item can open in the variation studio.

**Shared recorder** (`VideoRecorderPanel.tsx`). Add an optional `onRecordingComplete?(result, {sourceLabel, mode})` to
the provider and a "Save to Library" action in the result view; the shell then stores `RecordingResult` as a `recording`
item. Until then the shell records with its own `captureStream` recorder.

## Merge notes

The platform branch touches these shared files, each additively and at positions verified to merge cleanly with the
in-flight tree: `apps/studio/index.html` (script src → `/src/boot.ts`), `apps/studio/src/AtlasStudio.tsx` and
`AtlasViewport.tsx` (organ adapter hook and viewport capture/camera methods), `vitest.config.ts` (include),
package manifests and lockfile (new dependencies), `.github/workflows/pages.yml` (production `platform.json` + platform
smoke). `src/main.tsx`, `vite.config.ts`, lab folders and the public-copy scripts are untouched.
