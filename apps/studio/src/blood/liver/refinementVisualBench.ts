/** Development-only matched-resolution experiment. Not imported by product UI.
 * Captures real accepted coupled flow. No injected fluid, smoothed height,
 * remeshing of an accepted state, or image-dependent camera adjustment.
 */
import { bundledReference } from "../../atlasLocal";
import { photoDetailFor } from "../../photoDetail";
import { getSceneRecordingSource } from "../../sceneRecordingSource";
import { adaptLiverAnatomy, LIVER_TEMPLATE_ID } from "./anatomy";
import { refineLiverAnatomy } from "./refinement";
import { LiverFlowExperiment } from "./liverFlow";
import { LiverRenderer } from "./renderer";
import { prepareLiverCut } from "./wounds";
import type { LiverAppearance, LiverFlowSnapshot } from "./types";

type Check = { name: string; passed: boolean; details?: unknown };
interface ComparisonOptions { width?: number; height?: number; timesSeconds?: number[]; }
type View = LiverRenderer["visualState"];
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const serializable = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, item: unknown) =>
  ArrayBuffer.isView(item) ? Array.from(item as unknown as ArrayLike<number>) : item));
const difference = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return Infinity;
  let maximum = 0;
  for (let i = 0; i < a.length; i++) maximum = Math.max(maximum, Math.abs(a[i]! - b[i]!));
  return maximum;
};
const cameraPose = (view: View) => [...view.cameraPosition, ...view.cameraTarget,
  ...view.cameraQuaternion, ...view.cameraProjection, ...view.cameraWorldMatrix];
// Canonical normals are Float32; child midpoint normals incur another Float32
// rounding before normalized P1 reconstruction. A 2e-7 absolute component
// envelope (under two Float32 epsilons) is appropriate for these near-unit
// directions. It is not an SI position, aperture, or source-flow tolerance.
const DIRECTION_ABSOLUTE_TOLERANCE = 2e-7;
function physicalSummary(state: LiverFlowSnapshot) {
  const positiveDepth = state.film.depthM.filter(h => h > 0);
  return {
    timeSeconds: state.timeSeconds, stepIndex: state.stepIndex,
    filmVolumeM3: state.film.filmVolumeM3, filmInputVolumeM3: state.film.inputVolumeM3,
    escapedVolumeM3: state.film.escapedVolumeM3, maximumDepthM: state.film.maxDepthM,
    wetCanonicalVertices: positiveDepth.length,
    vesselPressurePa: state.vessel.pressurePa, sourcePressurePa: state.vessel.sourcePressurePa,
    inletFlowM3S: state.vessel.inletFlowM3S, distalFlowM3S: state.vessel.distalFlowM3S,
    expelledVolumeM3: state.vessel.expelledVolumeM3,
    inFlightVolumeM3: state.breakup.inFlightVolumeM3,
    circulatingVolumeM3: state.cardiovascular.circulatingVolumeM3,
    filmVolumeErrorM3: state.film.volumeErrorM3, coupledVolumeErrorM3: state.coupledVolumeErrorM3,
    sources: state.vessel.jets.map(jet => ({
      holeId: jet.holeId, positionM: [...jet.positionM], direction: [...jet.direction],
      radiusM: jet.radiusM, flowM3S: jet.flowM3S, velocityMS: jet.velocityMS,
      drivingPressurePa: jet.drivingPressurePa, expelledVolumeM3: jet.expelledVolumeM3,
    })),
  };
}

export async function liverRefinementVisualBench(options: ComparisonOptions = {}) {
  const width = options.width ?? 1920, height = options.height ?? 1080;
  const times = options.timesSeconds ?? [.5, 1, 2], dt = .002;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 640 || height < 360 ||
      width > 3840 || height > 2160 || !times.length || times.some((t, i) =>
        !Number.isFinite(t) || t <= 0 || t > 2 || Math.abs(t / dt - Math.round(t / dt)) > 1e-8 ||
        (i > 0 && t <= times[i - 1]!)))
    throw new RangeError("Invalid matched liver comparison settings");
  const checks: Check[] = [], captures: { name: string; dataUrl: string; metadata: unknown }[] = [];
  const states: unknown[] = [], runs: unknown[] = [], errors: string[] = [];
  const cameraReferences = new Map<string, number[]>();
  const matchedSources = new Map<number, ReturnType<typeof physicalSummary>>();
  const check = (name: string, passed: boolean, details?: unknown, failFast = true) => {
    checks.push({ name, passed, ...(details === undefined ? {} : { details }) });
    if (!passed && failFast) throw new Error(name);
  };
  const base = adaptLiverAnatomy(await bundledReference(LIVER_TEMPLATE_ID));
  const targetId = "liver-target-1", baseTarget = base.targets.find(target => target.id === targetId);
  if (!baseTarget) throw new Error("The bundled capsule has no comparison target1");
  const basePositionsBefore = base.surface.positionsM.slice(), baseIndicesBefore = base.surface.indices.slice();
  const baseAppearance: LiverAppearance = {
    illumination: "camera", exposureEV: 0, oxygenationFraction: .75, vesselGuide: false,
  };
  // Both renderers get the same resolved colour source, not a load-order race.
  const photo = await photoDetailFor(base.organ.id);
  const acceptedFailures: { level: number; requestedTimeSeconds: number; acceptedTimeSeconds: number; reason: string }[] = [];
  let referencePressurePosition: readonly number[] | undefined;
  // A punch can intersect a neighbouring branch with a larger exposed calibre
  // than the labelled guide target. The accepted geometric cut, not guide
  // metadata, defines the physical experiment at both resolutions.
  const coarseCut = prepareLiverCut(base, [], {
    pick: baseTarget.pick, radiusM: .00125, depthM: .001, timeSeconds: 0,
  });
  try {
    check("Independent coarse reference punch intersects an actual vessel",
      coarseCut.accepted && coarseCut.outcome === "vessel-hit" &&
      coarseCut.wound?.vesselId != null && coarseCut.wound.apertureRadiusM > 0, coarseCut);
    const coarseWound = coarseCut.wound!;
    const compareSources = (state: LiverFlowSnapshot) => {
      const summary = physicalSummary(state), coarse = matchedSources.get(state.timeSeconds);
      if (!coarse) { matchedSources.set(state.timeSeconds, summary); return; }
      const errors = summary.sources.map((source, index) => {
        const baseline = coarse.sources[index];
        return baseline ? {
          holeId: source.holeId, positionAbsoluteM: difference(source.positionM, baseline.positionM),
          directionAbsolute: difference(source.direction, baseline.direction),
          radiusAbsoluteM: Math.abs(source.radiusM - baseline.radiusM),
          flowAbsoluteM3S: Math.abs(source.flowM3S - baseline.flowM3S),
        } : null;
      });
      check(`Matched physical source at ${state.timeSeconds}s`,
        summary.sources.length === coarse.sources.length && summary.sources.every((source, index) => {
          const baseline = coarse.sources[index]!;
          return source.holeId === baseline.holeId &&
            difference(source.positionM, baseline.positionM) < 1e-12 &&
            difference(source.direction, baseline.direction) < DIRECTION_ABSOLUTE_TOLERANCE &&
            Math.abs(source.radiusM - baseline.radiusM) < 1e-12 &&
            Math.abs(source.flowM3S - baseline.flowM3S) <= Math.max(1e-16, Math.abs(baseline.flowM3S) * 1e-8);
        }), { coarse: coarse.sources, refined: summary.sources, observedErrors: errors,
          directionAbsoluteTolerance: DIRECTION_ABSOLUTE_TOLERANCE });
    };
    for (const level of [0, 1] as const) {
      console.info(`[liver-comparison] Beginning level ${level}`);
      const anatomy = refineLiverAnatomy(base, level), target = anatomy.targets.find(item => item.id === targetId)!;
      check(`Level ${level}: target world position and normal are identical`,
        difference(target.pick.positionM, baseTarget.pick.positionM) < 1e-12 &&
        difference(target.pick.normal, baseTarget.pick.normal) < 1e-12 &&
        target.vesselId === baseTarget.vesselId);
      const model = new LiverFlowExperiment(anatomy, { kind: "vein", viscosityPaS: .00345,
        heartRateBpm: 72, fixedDtSeconds: dt });
      const reference = model.vesselConfig.pressureReferencePositionM;
      if (!referencePressurePosition) referencePressurePosition = [...reference];
      check(`Level ${level}: hydraulic reference does not move with mesh resolution`,
        difference(reference, referencePressurePosition) < 1e-11, { reference });
      const chosen = prepareLiverCut(anatomy, [], {
        pick: target.pick, radiusM: .00125, depthM: .001, timeSeconds: 0,
      });
      const woundErrors = chosen.wound ? {
        normalAbsolute: difference(chosen.wound.pick.normal, coarseWound.pick.normal),
        positionAbsoluteM: difference(chosen.wound.pick.positionM, coarseWound.pick.positionM),
        apertureAbsoluteM: Math.abs(chosen.wound.apertureRadiusM - coarseWound.apertureRadiusM),
      } : null;
      check(`Level ${level}: same actual vessel is intersected by the punch`,
        chosen.accepted && chosen.outcome === "vessel-hit" &&
        chosen.wound?.vesselId === coarseWound.vesselId &&
        Math.abs(chosen.wound.apertureRadiusM - coarseWound.apertureRadiusM) < 1e-12 &&
        difference(chosen.wound.pick.positionM, coarseWound.pick.positionM) < 1e-12 &&
        difference(chosen.wound.pick.normal, coarseWound.pick.normal) < DIRECTION_ABSOLUTE_TOLERANCE,
        { labelledTargetVessel: baseTarget.vesselId, coarseWound, actual: chosen,
          observedErrors: woundErrors, directionAbsoluteTolerance: DIRECTION_ABSOLUTE_TOLERANCE });
      const host = document.createElement("div");
      host.style.cssText = "position:relative;width:1280px;height:720px"; document.body.appendChild(host);
      let view: LiverRenderer | undefined, lease: { restore(): void } | undefined;
      const abort = new AbortController();
      let acceptedSteps = 0, stepCpuMilliseconds = 0;
      const runStarted = performance.now();
      try {
        view = new LiverRenderer(host, { anatomy, onSurfacePick: () => {
          throw new Error("Comparison camera motion must never commit a cut");
        }, onError: error => errors.push(`level ${level}: ${error}`) });
        view.setAppearance(baseAppearance); view.setMode("orbit"); view.focusTarget(targetId);
        view.update(model.snapshot()); await frames(); view.render();
        check(`Level ${level}: visible collection floor equals physical contact plane`,
          Math.abs(view.visualState.collectionPlaneYM - model.vesselConfig.collectionPlaneYM) < 1e-15,
          { renderedYM: view.visualState.collectionPlaneYM, physicalYM: model.vesselConfig.collectionPlaneYM });
        check(`Level ${level}: photo detail resolution is shared`,
          view.visualState.photoDetail === (photo ? "loaded" : "unavailable"), view.visualState.photoDetail);
        const canvas = view.canvas, source = getSceneRecordingSource(canvas);
        check(`Level ${level}: renderer owns a registered native recording source`, !!source);
        lease = source!.prepare({ width, height, fps: 30, signal: abort.signal });
        check(`Level ${level}: capture is native ${width}×${height}`, canvas.width === width && canvas.height === height);

        const captureViews = (state: LiverFlowSnapshot, label: string,
          orbit: "base" | "left" | "right" | "up" | "down" | "down-one" | "down-two" = "base") => {
          const acceptedBefore = state.timeSeconds;
          view!.focusTarget(targetId);
          const key = orbit === "left" ? "ArrowLeft" : orbit === "right" ? "ArrowRight" :
            orbit === "up" ? "ArrowUp" : "ArrowDown";
          const orbitPresses = orbit === "base" ? 0 : orbit === "down-one" ? 1 : orbit === "down-two" ? 2 : 3;
          if (orbit !== "base") for (let i = 0; i < orbitPresses; i++)
            canvas.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
          for (const illumination of ["camera", "studio", "operating"] as const) {
            view!.setAppearance({ illumination }); view!.render();
            const visual = view!.visualState, pose = cameraPose(visual), comparisonKey = `${label}-${illumination}-${orbit}`;
            const referencePose = cameraReferences.get(comparisonKey);
            if (!referencePose) cameraReferences.set(comparisonKey, pose);
            else check(`Matched camera ${comparisonKey}`, difference(pose, referencePose) < 1e-9);
            check(`Level ${level} ${comparisonKey}: draw preserves accepted clock`, visual.timeSeconds === acceptedBefore);
            check(`Level ${level} ${comparisonKey}: displayed and physical inventory agree`,
              Math.abs(visual.filmVolumeM3 - state.film.filmVolumeM3) <= Math.max(1e-16, state.film.filmVolumeM3 * 1e-7));
            captures.push({ name: `level-${level}-${comparisonKey}`, dataUrl: canvas.toDataURL("image/png"),
              metadata: { level, label, orbit,
                orbitRadians: orbitPresses * .1 * (orbit === "left" || orbit === "up" ? 1 : -1),
                actualKey: orbitPresses ? key : null, keyPresses: orbitPresses,
                orbitAxis: orbit === "left" || orbit === "right" ? "azimuth" :
                  orbit !== "base" ? "polar" : "none",
                nominalInspectionAngleDegrees: orbit.startsWith("down")
                  ? visual.presentation.inspectionObliquityDegrees - orbitPresses * .1 * 180 / Math.PI : null,
                requestedNativeWidth: width, requestedNativeHeight: height,
                appearance: visual.appearance, cameraPose: pose, visual, physics: physicalSummary(state) } });
          }
          check(`Level ${level} ${label} ${orbit}: camera/light changes cannot integrate flow`,
            model.snapshot().timeSeconds === acceptedBefore);
        };

        captureViews(model.snapshot(), "dry");
        view.setWounds([chosen.wound!]); model.setWounds([chosen.wound!]); view.update(model.snapshot());
        compareSources(model.snapshot());
        for (const requestedTime of times) {
          const targetStep = Math.round(requestedTime / dt);
          let rejection: string | undefined;
          while (acceptedSteps < targetStep) {
            const start = performance.now(), result = model.step();
            stepCpuMilliseconds += performance.now() - start;
            if (!result.accepted) { rejection = result.reason ?? "Unknown physical rejection"; break; }
            acceptedSteps++;
            // Keep browser responsive, without advancing or drawing fake time.
            if (acceptedSteps % 25 === 0) await frames();
          }
          const state = model.snapshot(); view.update(state);
          const label = rejection ? `rejected-t-${Math.round(state.timeSeconds * 1000).toString().padStart(4, "0")}`
            : `t-${Math.round(requestedTime * 1000).toString().padStart(4, "0")}`;
          states.push({ level, label, requestedTimeSeconds: requestedTime, acceptedTimeSeconds: state.timeSeconds,
            snapshot: serializable(state), diagnostics: serializable(model.diagnostics()),
            vesselConfig: serializable(model.vesselConfig), rejection: rejection ?? null });
          check(`Level ${level}: ${requestedTime}s accepted`, !rejection &&
            Math.abs(state.timeSeconds - requestedTime) < 1e-12, rejection, false);
          captureViews(state, label);
          if (rejection) {
            acceptedFailures.push({ level, requestedTimeSeconds: requestedTime,
              acceptedTimeSeconds: state.timeSeconds, reason: rejection });
            break;
          }
          // Film resolution may change the film outcome, not its source.
          compareSources(state);
          if (requestedTime === 2) {
            captureViews(state, label, "left"); captureViews(state, label, "right");
            captureViews(state, label, "up"); captureViews(state, label, "down");
            captureViews(state, label, "down-one"); captureViews(state, label, "down-two");
          }
          console.info(`[liver-comparison] Level ${level} accepted ${requestedTime}s`);
        }
        runs.push({ level, vertices: anatomy.surface.positionsM.length / 3, triangles: anatomy.surface.indices.length / 3,
          target: serializable(target), wound: serializable(chosen.wound), options: model.options,
          vesselConfig: serializable(model.vesselConfig), acceptedSteps,
          stepCpuMilliseconds, meanAcceptedStepCpuMilliseconds: stepCpuMilliseconds / Math.max(1, acceptedSteps),
          elapsedMilliseconds: performance.now() - runStarted,
          timingInterpretation: "Diagnostic browser timings including live validation; not a controlled performance benchmark" });
        lease.restore(); lease = undefined; abort.abort(); await frames();
        check(`Level ${level}: native capture lease restores viewport ownership`, !view.visualState.recording);
        view.dispose(); view.dispose();
        check(`Level ${level}: source and canvas are disposed before the next renderer`,
          !getSceneRecordingSource(canvas) && !canvas.isConnected);
      } finally {
        lease?.restore(); abort.abort(); view?.dispose(); host.remove();
      }
    }
    check("Canonical base source positions and indices remain unchanged",
      difference(base.surface.positionsM, basePositionsBefore) === 0 &&
      difference(base.surface.indices, baseIndicesBefore) === 0);
    check("No renderer execution errors", errors.length === 0, errors);
    return { status: acceptedFailures.length ? "INCOMPLETE" : "PASS", checks, captures, states, runs, errors, acceptedFailures,
      reference: base.provenance, targetId, coarseReferenceWound: serializable(coarseCut.wound),
      cut: { radiusM: .00125, depthM: .001 }, timesSeconds: times,
      comparison: "One shared source; same physical target, hydraulic input, native dimensions, poses and lighting. Independent accepted fixed-step flows at each physical resolution.",
      modelAndRealismCertified: false };
  } catch (error) {
    checks.push({ name: error instanceof Error ? error.message : String(error), passed: false });
    return { status: "FAIL", checks, captures, states, runs, errors, acceptedFailures,
      error: String(error instanceof Error ? error.stack : error), modelAndRealismCertified: false };
  }
}
