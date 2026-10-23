/** Development-only accepted-time motion capture. Product UI never imports it.
 * Video samples cover [0,duration) at exactly fps^-1 physical intervals.
 * The accepted t=duration endpoint is saved separately, never as an extra
 * video frame (which would incorrectly extend the encoded duration).
 * Offline encoding avoids confusing a slow device with a slower fluid.
 */
import { loadLiverAnatomy } from "./anatomy";
import { photoDetailFor } from "../../photoDetail";
import { getSceneRecordingSource } from "../../sceneRecordingSource";
import { LiverRenderer } from "./renderer";
import { LiverFlowExperiment } from "./liverFlow";
import { prepareLiverCut } from "./wounds";
import type { LiverAppearance } from "./types";

interface MotionOptions {
  width: number; height: number; fps: number; durationSeconds: number;
  illumination: LiverAppearance["illumination"]; kind: "vein" | "artery";
  view: "wound" | "overview";
  undersideBoundary: "drain" | "retain";
}
declare global {
  interface Window {
    __saveLiverMotionFrame: (frame: { index: number; timeSeconds: number; endpoint: boolean; dataUrl: string }) => Promise<void>;
    __saveLiverMotionFailure: (state: unknown) => Promise<void>;
  }
}
const serializable = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, item: unknown) =>
  ArrayBuffer.isView(item) ? Array.from(item as unknown as ArrayLike<number>) : item));

export async function liverMotionBench(options: MotionOptions) {
  const { width, height, fps, durationSeconds, illumination, kind } = options;
  if (![1280, 1920, 3840].includes(width) || height !== width * 9 / 16 ||
      ![10, 20, 25].includes(fps) || !Number.isFinite(durationSeconds) || durationSeconds < 1 ||
      durationSeconds > 15 || !Number.isSafeInteger(durationSeconds * fps) ||
      !["camera", "studio", "operating"].includes(illumination) || !["vein", "artery"].includes(kind)
      || !["wound", "overview"].includes(options.view)
      || !["drain", "retain"].includes(options.undersideBoundary))
    throw new RangeError("Invalid liver motion capture");
  if (typeof window.__saveLiverMotionFrame !== "function") throw new Error("Motion frame sink is missing");
  const anatomy = await loadLiverAnatomy();
  await photoDetailFor(anatomy.organ.id);
  const model = new LiverFlowExperiment(anatomy, { kind, undersideBoundary: options.undersideBoundary });
  const dt = model.vesselConfig.fixedDtSeconds, stepsPerFrame = Math.round(1 / fps / dt);
  if (Math.abs(stepsPerFrame * dt - 1 / fps) > 1e-12) throw new RangeError("Capture cadence must divide physical time exactly");
  const host = document.createElement("div"); host.style.cssText = "position:relative;width:1280px;height:720px";
  document.body.appendChild(host);
  const errors: string[] = [], checkpoints: unknown[] = [];
  const abort = new AbortController();
  let lease: { restore(): void } | undefined;
  let view: LiverRenderer | undefined, failure: unknown;
  try {
    view = new LiverRenderer(host, { anatomy, onSurfacePick: () => {
      throw new Error("Motion review must not mutate its predefined incision");
    }, onError: error => errors.push(error) });
    view.setMode("orbit");
    view.setAppearance({ illumination, exposureEV: 0, vesselGuide: false, oxygenationFraction: kind === "vein" ? .75 : .98 });
    const target = anatomy.targets[0]!;
    view.focusTarget(target.id);
    if (options.view === "overview") view.fitLiver();
    const cut = prepareLiverCut(anatomy, [], { pick: target.pick, radiusM: .00125, depthM: .001, timeSeconds: 0 });
    if (!cut.accepted || cut.outcome !== "vessel-hit" || !cut.wound) throw new Error("Motion target did not intersect a vessel");
    view.setWounds([cut.wound]); model.setWounds([cut.wound]); view.update(model.snapshot()); view.render();
    const source = getSceneRecordingSource(view.canvas);
    if (!source) throw new Error("Native recording source is missing");
    lease = source.prepare({ width, height, fps, signal: abort.signal });
    if (view.canvas.width !== width || view.canvas.height !== height) throw new Error("Capture is not native resolution");
    const totalFrames = durationSeconds * fps;
    let maxConservationErrorM3 = 0;
    for (let frame = 0; frame <= totalFrames; frame++) {
      if (frame) for (let i = 0; i < stepsPerFrame; i++) {
        const result = model.step();
        if (!result.accepted) throw new Error(`Rejected at ${model.snapshot().timeSeconds}s: ${result.reason}`);
      }
      const state = model.snapshot();
      if (!Number.isFinite(state.timeSeconds) || Math.abs(state.timeSeconds - frame / fps) > 1e-10)
        throw new Error("Physical frame cadence drifted");
      if (!Number.isFinite(state.coupledVolumeErrorM3) ||
          Math.abs(state.coupledVolumeErrorM3) > model.initialInventoryM3 * 1e-10)
        throw new Error("Accepted frame exceeds the coupled inventory tolerance");
      maxConservationErrorM3 = Math.max(maxConservationErrorM3, Math.abs(state.coupledVolumeErrorM3));
      view.update(state); view.render();
      const visual = view.visualState;
      const volumeMatches = (actual: number, accepted: number, relative = 1e-10, absolute = 1e-20) =>
        Number.isFinite(actual) && Number.isFinite(accepted) && actual >= 0 && accepted >= 0 &&
        Math.abs(actual - accepted) <= Math.max(absolute, accepted * relative);
      const sourceDrops = state.breakup.droplets.reduce((sum, drop) => sum + drop.volumeM3, 0);
      const sourceLigaments = state.breakup.ligaments.reduce((sum, ligament) => sum + ligament.volumeM3, 0);
      if (!volumeMatches(visual.filmVolumeM3, state.film.filmVolumeM3, 1e-7, 1e-16))
        throw new Error("Displayed film volume differs from accepted inventory");
      if (visual.runoffDropletCount !== state.runoff.droplets.length ||
          visual.sourceDropletCount !== state.breakup.droplets.length ||
          visual.dropletCount !== state.runoff.droplets.length + state.breakup.droplets.length ||
          visual.ligamentCount !== state.breakup.ligaments.length ||
          visual.timeSeconds !== state.timeSeconds ||
          !volumeMatches(visual.runoff.inFlightVolumeM3, state.runoff.inFlightVolumeM3) ||
          !volumeMatches(visual.reconstructedDropletVolumeM3, sourceDrops + state.runoff.inFlightVolumeM3) ||
          !volumeMatches(visual.reconstructedJetVolumeM3, sourceLigaments, 1e-7) ||
          !volumeMatches(visual.runoff.attachedAcceptedVolumeM3, state.runoff.attachedVolumeM3) ||
          !volumeMatches(visual.runoff.attachedReconstructedVolumeM3, state.runoff.attachedVolumeM3, .004) ||
          !volumeMatches(visual.collector.acceptedVolumeM3, state.collector.filmVolumeM3) ||
          !volumeMatches(visual.collector.reconstructedVolumeM3, state.collector.filmVolumeM3, 5e-7))
        throw new Error("Displayed runoff/collector inventory differs from accepted blood");
      if (errors.length || visual.contextLost) throw new Error(errors.join("\n") || "Rendering context lost");
      if (view.canvas.width !== width || view.canvas.height !== height) throw new Error("Native capture dimensions changed");
      await window.__saveLiverMotionFrame({ index: frame, timeSeconds: state.timeSeconds,
        endpoint: frame === totalFrames, dataUrl: view.canvas.toDataURL("image/jpeg", .96) });
      if (frame % fps === 0 || frame === totalFrames) {
        checkpoints.push({ timeSeconds: state.timeSeconds, snapshot: serializable(state),
          diagnostics: serializable(model.diagnostics()), renderer: serializable(visual) });
        console.info(`[liver-motion] Accepted ${state.timeSeconds.toFixed(1)}s`);
      }
    }
    if (errors.length) throw new Error(errors.join("\n"));
    return { status: "PASS", options, frames: totalFrames, endpointFrames: 1, maxConservationErrorM3,
      sampleIntervalSeconds: 1 / fps, lastVideoFrameTimeSeconds: (totalFrames - 1) / fps,
      acceptedEndpointTimeSeconds: durationSeconds, encodedDurationSeconds: durationSeconds,
      reference: anatomy.provenance, refinement: anatomy.refinement ? {
        level: anatomy.refinement.level, baseVertexCount: anatomy.refinement.baseVertexCount,
        baseTriangleCount: anatomy.refinement.baseTriangleCount,
        vertexCount: anatomy.surface.positionsM.length / 3, triangleCount: anatomy.surface.indices.length / 3,
      } : null, wound: cut.wound,
      modelOptions: model.options, checkpoints, errors,
      timing: "Offline video samples [0,duration) with one frame per physical interval; the accepted duration endpoint is a separate still/checkpoint. This is not a live FPS benchmark.",
      visualRealismCertified: false };
  } catch (error) {
    failure = error;
    // A rejected long run must retain its last accepted physical state even
    // though the normal end-of-run result will never reach the harness.
    if (typeof window.__saveLiverMotionFailure === "function") {
      try {
        await window.__saveLiverMotionFailure(serializable({
          schema: "viscera.liver-motion-failure/v1", reason: String(error),
          snapshot: model.snapshot(), diagnostics: model.diagnostics(),
          renderer: view?.visualState ?? null,
          qualification: "The physical state may be later than the last rendered sample; neither is an accepted endpoint of the requested trial.",
        }));
      } catch (receiptError) {
        throw new AggregateError([error, receiptError], "Motion capture failed and its failure receipt could not be saved");
      }
    }
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [() => lease?.restore(), () => abort.abort(), () => view?.dispose(), () => host.remove()]) {
      try { cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(failure === undefined ? cleanupErrors : [failure, ...cleanupErrors],
      "Motion capture or its independent cleanup failed");
  }
}
