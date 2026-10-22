// Connects AtlasStudio (Organ Design, ?mode=atlas; the Texture Lab, ?mode=textures) to the account platform through
// the lab-session bridge. AtlasStudio calls this hook once with its own state, setters and refs; the hook registers the
// organ adapter (adapter.ts), tells the platform when the saved document or only the view changed, and performs the
// studio-side steps of a restore on React's schedule. Standalone (no platform around the iframe) the adapter is
// registered and nobody listens: the studio behaves exactly as before.
//
// restore=pending: a lab the platform opened to receive a saved document must not generate its default organ first
// (DESIGN.md §15.6). generate() refuses to run while a trained-model switch holds modelSwitchingRef; holding that flag
// from mount until restore()/startFresh() skips the studio's start-up generation without editing its load effect,
// which also keeps loading the catalog the restore needs.

import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { SceneData } from "@viscera/render";
import { isEmbeddedInPlatform, isRestorePending, registerLabSession, type LabSessionAdapter, type LabSessionHandle } from "../../bridge/labSession";
import { defaultAtlasSpec, type AtlasCatalog, type AtlasGeneration, type AtlasSpec } from "../../../atlas";
import type { AtlasView, AtlasViewportHandle } from "../../../AtlasViewport";
import { emptySculptHistory, type SculptHistory, type SurfaceEdit } from "../../../atlasSculptHistory";
import type { PhotoTileInfo } from "../../../photoDetail";
import { createOrganLabAdapter, type OrganCurrentState, type OrganRestoreSettings, type OrganStudioPort } from "./adapter";
import {
  DEFAULT_VESSELS,
  OrganSessionError,
  cameraDistance,
  defaultPhoto,
  defaultTools,
  readCamera,
  roundCamera,
  type AtlasSessionCamera,
  type AtlasSessionState,
  type InspectorTab,
  type JointSeverity,
  type JsonRecord,
  type OrganLabId,
} from "./session";

type Setter<T> = Dispatch<SetStateAction<T>>;

/** AtlasStudio's state, setters and refs the session needs (names as in AtlasStudio.tsx). */
export interface OrganStudioBindings {
  textureLab: boolean;
  catalog: AtlasCatalog | null;
  catalogRef: RefObject<AtlasCatalog | null>;
  generated: AtlasGeneration | null;
  committed: RefObject<AtlasGeneration | null>;
  setGenerated: Setter<AtlasGeneration | null>;
  generate: (spec: AtlasSpec) => Promise<boolean>;
  busy: string | null;
  exporting: boolean;
  modelSwitching: boolean;
  modelSwitchingRef: RefObject<boolean>;
  error: string;
  cancelPendingPreview: () => void;
  activeRequest: RefObject<AbortController | null>;
  requestId: RefObject<number>;
  sculptHistory: SculptHistory;
  sculptHistoryRef: RefObject<SculptHistory>;
  setSculptHistory: Setter<SculptHistory>;
  setSculptEnabled: Setter<boolean>;
  setSculptReport: Setter<string>;
  vesselsEnabled: boolean;
  setVesselsEnabled: Setter<boolean>;
  vesselDensity: number;
  setVesselDensity: Setter<number>;
  vesselVisibility: number;
  setVesselVisibility: Setter<number>;
  vesselRadiusScale: number;
  setVesselRadiusScale: Setter<number>;
  vesselSeed: number;
  setVesselSeed: Setter<number>;
  photoDetail: number;
  setPhotoDetail: Setter<number>;
  photoRelief: number;
  setPhotoRelief: Setter<number>;
  photoTile: PhotoTileInfo | null;
  wireframe: boolean;
  setWireframe: Setter<boolean>;
  view: AtlasView;
  setView: Setter<AtlasView>;
  inspectorTab: InspectorTab;
  setInspectorTab: Setter<InspectorTab>;
  sculptRadius: number;
  setSculptRadius: Setter<number>;
  sculptStiffness: number;
  setSculptStiffness: Setter<number>;
  variationStrength: number;
  setVariationStrength: Setter<number>;
  jointTemperature: number;
  setJointTemperature: Setter<number>;
  jointSeverity: JointSeverity;
  setJointSeverity: Setter<JointSeverity>;
  matchDimensions: boolean;
  setMatchDimensions: Setter<boolean>;
  viewport: RefObject<AtlasViewportHandle | null>;
  displayedScene: SceneData | null;
}

/** The AtlasViewport handle methods the platform added (AtlasViewport.tsx, after captureMetadata). */
export interface OrganViewportExtras {
  getCamera(): { position_mm: number[]; target_mm: number[]; up: number[]; fov_degrees: number; near_mm: number; far_mm: number } | null;
  setCamera(camera: AtlasSessionCamera): boolean;
  isInteracting(): boolean;
  captureThumbnail(options: { width: number; height: number; background?: "stage" | "transparent" | undefined }): Promise<Blob | null>;
}

/** The viewport handle with the platform methods, checked at run time (null without a viewport). */
export function organViewport(handle: AtlasViewportHandle | null | undefined): (AtlasViewportHandle & OrganViewportExtras) | null {
  if (!handle) return null;
  const candidate = handle as AtlasViewportHandle & Partial<OrganViewportExtras>;
  const complete = typeof candidate.getCamera === "function" && typeof candidate.setCamera === "function"
    && typeof candidate.isInteracting === "function" && typeof candidate.captureThumbnail === "function";
  return complete ? (candidate as AtlasViewportHandle & OrganViewportExtras) : null;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted.", "AbortError");
}

function sameValues(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

/** The session state machine of one mounted studio; also the OrganStudioPort the adapter drives. */
class OrganLabBridge implements OrganStudioPort {
  readonly labId: OrganLabId;
  readonly textureLab: boolean;
  readonly adapter: LabSessionAdapter<AtlasSessionState>;
  // what the last commit showed (React has mounted it, the viewport included: child effects run first)
  private shown: OrganStudioBindings;
  private waitingForPlatform: boolean;
  private holdingStartup = false;
  private eventsHeld = 0;
  private baseline: { document: unknown[]; view: unknown[] } | null = null;
  private lastCamera: AtlasSessionCamera | null = null;
  private expectedSculpt: SurfaceEdit[] | null = null;
  private readonly commitListeners = new Set<() => void>();
  private handle: LabSessionHandle | null = null;

  constructor(private readonly latest: RefObject<OrganStudioBindings>, restorePending: boolean) {
    this.shown = latest.current;
    this.textureLab = latest.current.textureLab;
    this.labId = this.textureLab ? "texture-lab" : "organ";
    this.waitingForPlatform = restorePending;
    this.adapter = createOrganLabAdapter(this);
  }

  // React side ------------------------------------------------------------------------------------------------------

  register(): () => void {
    this.holdStartup();
    const handle = registerLabSession(this.adapter);
    this.handle = handle;
    return () => {
      handle.dispose();
      if (this.handle === handle) this.handle = null;
      this.releaseStartup();
    };
  }

  /** After every commit: wake waiters, then report what changed since the baseline. */
  committed(studio: OrganStudioBindings): void {
    this.shown = studio;
    for (const listener of [...this.commitListeners]) listener();
    this.trackChanges();
  }

  /** Orbit and zoom end with a pointer release or a wheel turn over the viewport: report a view change once it settles. */
  watchCamera(): () => void {
    if (typeof window === "undefined" || !isEmbeddedInPlatform()) return () => {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      timer = null;
      if (this.eventsHeld || this.waitingForPlatform || !this.baseline) return;
      const camera = this.camera();
      if (!camera) return;
      const previous = this.lastCamera;
      this.lastCamera = camera;
      if (previous && cameraDistance(previous, camera) > 1e-6) this.handle?.changed("view");
    };
    const schedule = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".atlas-viewport-canvas")) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(settle, 400);
    };
    window.addEventListener("pointerup", schedule, true);
    window.addEventListener("wheel", schedule, { capture: true, passive: true });
    return () => {
      if (timer !== null) clearTimeout(timer);
      window.removeEventListener("pointerup", schedule, true);
      window.removeEventListener("wheel", schedule, { capture: true });
    };
  }

  private holdStartup(): void {
    if (!this.waitingForPlatform) return;
    this.holdingStartup = true;
    this.latest.current.modelSwitchingRef.current = true;
  }

  private releaseStartup(): void {
    if (!this.holdingStartup) return;
    this.holdingStartup = false;
    const studio = this.latest.current;
    studio.modelSwitchingRef.current = studio.modelSwitching;
  }

  private trackChanges(): void {
    const s = this.shown;
    // nothing to compare while loading, while waiting for the platform or while a restore applies its state
    if (this.waitingForPlatform || this.eventsHeld > 0 || !s.generated) return;
    const document = [s.generated, s.sculptHistory.present, s.vesselsEnabled, s.vesselSeed, s.vesselDensity, s.vesselVisibility, s.vesselRadiusScale, s.photoDetail, s.photoRelief];
    const view = [s.wireframe, s.view];
    const before = this.baseline;
    this.baseline = { document, view };
    if (!before) {
      // the first organ shown (or the restored one) is the baseline, not a change
      this.lastCamera = this.camera();
      return;
    }
    if (!sameValues(before.document, document)) this.handle?.changed("document");
    else if (!sameValues(before.view, view)) this.handle?.changed("view");
  }

  /** Resolves with probe()'s first defined answer, checked now and after every commit; probe may throw to reject. */
  private waitFor<T>(signal: AbortSignal, probe: () => T | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const stop = () => {
        this.commitListeners.delete(check);
        signal.removeEventListener("abort", onAbort);
      };
      const check = () => {
        let value: T | undefined;
        try {
          value = probe();
        } catch (error) {
          stop();
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (value !== undefined) {
          stop();
          resolve(value);
        }
      };
      const onAbort = () => {
        stop();
        reject(abortError(signal));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.commitListeners.add(check);
      check();
    });
  }

  /** The next commit, or the timeout (a generate() that failed renders its error message in one commit). */
  private nextCommit(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.commitListeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.commitListeners.add(done);
    });
  }

  private viewport(): (AtlasViewportHandle & OrganViewportExtras) | null {
    return organViewport(this.latest.current.viewport.current);
  }

  private clearSculpture(): void {
    const studio = this.latest.current;
    const empty = emptySculptHistory();
    // generate() reads the ref: a sculpture left there makes it refuse a different shape
    studio.sculptHistoryRef.current = empty;
    studio.setSculptHistory(empty);
    studio.setSculptReport("");
  }

  // OrganStudioPort -------------------------------------------------------------------------------------------------

  current(): OrganCurrentState | null {
    const s = this.shown;
    const catalog = s.catalogRef.current ?? s.catalog;
    if (this.waitingForPlatform || !catalog || !s.generated) return null;
    return {
      catalog,
      generation: s.generated,
      sculpt: s.sculptHistory.present,
      displayedScene: s.displayedScene,
      vessels: { enabled: s.vesselsEnabled, seed: s.vesselSeed, density: s.vesselDensity, visibility: s.vesselVisibility, radius_scale: s.vesselRadiusScale },
      photo: this.textureLab ? { strength: s.photoDetail, relief_mm: s.photoRelief } : null,
      view: { preset: s.view, wireframe: s.wireframe },
      tools: {
        inspector_tab: s.inspectorTab,
        sculpt_radius_mm: s.sculptRadius,
        sculpt_stiffness: s.sculptStiffness,
        variation_strength: s.variationStrength,
        joint_temperature: s.jointTemperature,
        joint_severity: s.jointSeverity,
        match_dimensions: s.matchDimensions,
      },
      photoTile: s.photoTile,
    };
  }

  studioBusy(): false | string {
    const s = this.latest.current;
    if (s.modelSwitching || (s.modelSwitchingRef.current && !this.holdingStartup)) return "loading";
    if (s.busy) return s.busy === "library" ? "loading" : "running";
    if (s.exporting) return "exporting";
    if (!s.generated) return "loading";
    // a sculpt stroke in progress: its geometry is mid-edit
    if (this.viewport()?.isInteracting()) return "editing";
    return false;
  }

  pending(): boolean {
    return this.waitingForPlatform;
  }

  catalog(signal: AbortSignal): Promise<AtlasCatalog> {
    return this.waitFor(signal, () => {
      const s = this.shown;
      const catalog = s.catalogRef.current;
      if (catalog) return catalog;
      if (!s.busy && s.error) throw new OrganSessionError(`The anatomy library could not be loaded: ${s.error}`);
      return undefined;
    });
  }

  beginRestore(): void {
    this.eventsHeld += 1;
    this.waitingForPlatform = false;
    const studio = this.latest.current;
    // quiesce as switching workspaces does: no preview may commit over the restored organ
    studio.cancelPendingPreview();
    studio.activeRequest.current?.abort();
    studio.requestId.current += 1;
    studio.setSculptEnabled(false);
    this.clearSculpture();
    this.releaseStartup();
  }

  endRestore(): void {
    this.eventsHeld = Math.max(0, this.eventsHeld - 1);
    this.expectedSculpt = null;
    if (this.eventsHeld > 0) return;
    // the restored state (settled) is the new baseline
    this.baseline = null;
    this.trackChanges();
  }

  applySettings(settings: OrganRestoreSettings): void {
    const studio = this.latest.current;
    const { vessels, photo, view, tools } = settings;
    studio.setVesselsEnabled(vessels.enabled);
    studio.setVesselSeed(vessels.seed);
    studio.setVesselDensity(vessels.density);
    studio.setVesselVisibility(vessels.visibility);
    studio.setVesselRadiusScale(vessels.radius_scale);
    if (photo && this.textureLab) {
      studio.setPhotoDetail(photo.strength);
      studio.setPhotoRelief(photo.relief_mm);
    }
    studio.setWireframe(view.wireframe);
    studio.setView(view.preset);
    if (tools) {
      studio.setInspectorTab(tools.inspector_tab);
      studio.setSculptRadius(tools.sculpt_radius_mm);
      studio.setSculptStiffness(tools.sculpt_stiffness);
      studio.setVariationStrength(tools.variation_strength);
      studio.setJointTemperature(tools.joint_temperature);
      studio.setJointSeverity(tools.joint_severity);
      studio.setMatchDimensions(tools.match_dimensions);
    }
  }

  async generate(spec: AtlasSpec, signal: AbortSignal): Promise<AtlasGeneration> {
    const studio = this.latest.current;
    signal.throwIfAborted();
    const cancel = () => {
      studio.activeRequest.current?.abort();
      studio.requestId.current += 1;
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (studio.modelSwitchingRef.current) throw new OrganSessionError("A trained model is being switched. Try again in a moment.");
      const done = await studio.generate(spec);
      if (signal.aborted) throw abortError(signal);
      const result = studio.committed.current;
      if (!done || !result) {
        // generate() reports failures through the studio's error state: read it once it has rendered
        await this.nextCommit(1500);
        throw new OrganSessionError(this.latest.current.error || "The organ could not be generated.");
      }
      return result;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  mergeProvenance(provenance: JsonRecord): void {
    const studio = this.latest.current;
    const generation = studio.committed.current;
    if (!generation) return;
    // a new object: the committed generation can be the shared, cached bundled reference
    const merged: AtlasGeneration = { ...generation, summary: { ...generation.summary, ...provenance } };
    studio.committed.current = merged;
    studio.setGenerated(merged);
  }

  applySculpt(edits: SurfaceEdit[]): void {
    const studio = this.latest.current;
    const history: SculptHistory = { past: [], present: edits, future: [] };
    studio.sculptHistoryRef.current = history;
    studio.setSculptHistory(history);
    this.expectedSculpt = edits;
  }

  settle(signal: AbortSignal): Promise<void> {
    return this.waitFor(signal, () => {
      const s = this.shown;
      const generation = this.latest.current.committed.current;
      if (!generation || s.generated !== generation || !s.displayedScene) return undefined;
      if (this.expectedSculpt && s.sculptHistory.present !== this.expectedSculpt) return undefined;
      return true;
    }).then(() => undefined);
  }

  camera(): AtlasSessionCamera | null {
    const raw = this.viewport()?.getCamera();
    if (!raw) return null;
    try {
      return roundCamera(readCamera(raw));
    } catch {
      return null;
    }
  }

  setCamera(camera: AtlasSessionCamera): boolean {
    return this.viewport()?.setCamera(camera) ?? false;
  }

  thumbnail(width: number, height: number): Promise<Blob | null> {
    return this.viewport()?.captureThumbnail({ width, height, background: "stage" }) ?? Promise.resolve(null);
  }

  startFresh(): void {
    this.waitingForPlatform = false;
    this.releaseStartup();
    this.baseline = null;
    // back to the studio's start-up values, which a failed restore may have changed
    this.applySettings({
      vessels: DEFAULT_VESSELS,
      photo: this.textureLab ? defaultPhoto(true) : null,
      view: { preset: "oblique", wireframe: false },
      tools: defaultTools(this.textureLab),
    });
    this.clearSculpture();
    const never = new AbortController().signal;
    void this.catalog(never).then((catalog) => {
      // the studio's own start-up choice (AtlasStudio's load effect): ?template, else the liver, else the first organ
      const requested = new URLSearchParams(window.location.search).get("template");
      const template = catalog.organs.flatMap((organ) => organ.templates).find((item) => item.id === requested)
        ?? catalog.organs.find((organ) => organ.id === "liver")?.templates[0]
        ?? catalog.organs[0]?.templates[0];
      if (template) void this.latest.current.generate(defaultAtlasSpec(catalog, template.id));
    }, () => {
      // the studio shows why its library did not load
    });
  }
}

/**
 * Registers Organ Design / the Texture Lab with the account platform for as long as AtlasStudio is mounted. Call it
 * once, unconditionally, with the studio's current values (see OrganStudioBindings).
 */
export function useOrganLabSession(studio: OrganStudioBindings): void {
  const latest = useRef(studio);
  latest.current = studio;
  // decided once per load: the platform adds restore=pending to the URL it opens
  const [restorePending] = useState(isRestorePending);
  const bridge = useRef<OrganLabBridge | null>(null);
  bridge.current ??= new OrganLabBridge(latest, restorePending);
  useEffect(() => {
    const session = bridge.current!;
    const unregister = session.register();
    const unwatch = session.watchCamera();
    return () => {
      unwatch();
      unregister();
    };
  }, []);
  // every commit: restore steps wait for the state they set to be on screen; change events compare with the baseline
  useEffect(() => {
    bridge.current!.committed(studio);
  });
}
