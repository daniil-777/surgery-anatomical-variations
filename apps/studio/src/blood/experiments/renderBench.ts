/** Explicit development-only WebGL gate; never imported by the application.
 * Validates displayed accepted states, appearance and native-capture ownership.
 * It is not a surgical-realism or physical-colour calibration certificate.
 */
import { collectorTrayRimHeightM, COLLECTOR_TRAY_WALL_THICKNESS_M, TankRenderer, VesselRenderer, type VesselRenderFrame } from "./renderer";
import { TankSolver } from "./tankSolver";
import { createVesselPreset } from "./vesselSolver";
import { VesselFlowExperiment } from "./vesselFlow";
import { vesselApertures, vesselFrame, type VesselGeometryConfig } from "./geometry";
import { getSceneRecordingSource } from "../../sceneRecordingSource";
import { Quaternion, Vector3 } from "three";

type Check = { name: string; passed: boolean; details?: unknown };
type View = TankRenderer | VesselRenderer;
type Capture = { name: string; dataUrl: string };
type Fixture = {
  view: View;
  physics(): string;
  evolve(): void;
  submit(): void;
  submitStale(): void;
  mutateCallerFrame(): void;
  invalid: { name: string; submit(): void }[];
  framingCornersM?: readonly (readonly [number, number, number])[];
  impactVisibilityDomain?: { originXM: number; originZM: number; widthM: number; depthM: number; planeYM: number; rimHeightM: number };
};
const layoutFrame = () => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const sleepEvent = (target: EventTarget, name: string) => new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => { target.removeEventListener(name, done); reject(new Error(`${name} timeout`)); }, 3000);
  const done = () => { clearTimeout(timeout); resolve(); };
  target.addEventListener(name, done, { once: true });
});
const clone = <T>(value: T): T => structuredClone(value);

function fixture(kind: "tank" | "vessel", host: HTMLElement, onError: (message: string) => void): Fixture {
  if (kind === "tank") {
    const solver = new TankSolver({ initialWaveAmplitudeM: .0005 });
    const dropped = solver.drop({ shape: "sphere", radiusM: .004, xM: .075, zM: .075,
      dropHeightM: .0005, densityKgM3: 750 });
    if (!dropped.accepted) throw new Error(dropped.reason);
    const view = new TankRenderer(host, { ...solver.config, onError });
    const current = () => solver.snapshot();
    const initial = current();
    return {
      view, physics: () => JSON.stringify(current()), submit: () => view.update(current()),
      submitStale: () => view.update(initial),
      evolve() {
        for (let i = 0; i < 120; i++) {
          const result = solver.step(); if (!result.accepted) throw new Error(result.reason);
        }
        view.update(current());
      },
      mutateCallerFrame() {
        const frame = current(); view.update(frame);
        frame.heightM.fill(NaN);
        if (frame.body) (frame.body.positionM as unknown as number[])[1] = NaN;
      },
      invalid: [
        { name: "NaN time", submit: () => view.update({ ...current(), timeSeconds: NaN }) },
        { name: "negative time", submit: () => view.update({ ...current(), timeSeconds: -1 }) },
        { name: "NaN height", submit: () => {
          const frame = current(); frame.heightM[4] = NaN; view.update(frame);
        } },
        { name: "wrong grid shape", submit: () => view.update({ ...current(), heightM: new Float64Array(4) }) },
        { name: "invalid body", submit: () => view.update({ ...current(),
          body: { shape: "sphere", positionM: [.075, NaN, .075], radiusM: .004 } }) },
      ],
    };
  }
  const geometry: VesselGeometryConfig = {
    innerRadiusM: .003, wallThicknessM: .00065,
    centrelineM: [[-.03, .025, 0], [-.015, .028, .002], [0, .026, .003], [.015, .023, .001], [.03, .025, 0]],
    holes: [],
  };
  const frame = vesselFrame(geometry);
  const normal = frame.point(.4, 0, 0).radial, binormal = frame.point(.4, Math.PI / 2, 0).radial;
  geometry.holes = [{ id: "bench-hole", arcFraction: .4, radiusM: .00035,
    angleRad: Math.atan2(-.3 * binormal.y + .95 * binormal.z, -.3 * normal.y + .95 * normal.z) }];
  const config = createVesselPreset("artery", {
    innerRadiusM: geometry.innerRadiusM, lengthM: frame.lengthM,
    pressureReferencePositionM: frame.curve.getPointAt(.5).toArray() as [number, number, number],
  });
  const solver = new VesselFlowExperiment(config); solver.setHoles(vesselApertures(geometry));
  const view = new VesselRenderer(host, { ...geometry, collectionPlaneYM: config.collectionPlaneYM,
    collectionWidthM: solver.collectorConfig.widthM, collectionDepthM: solver.collectorConfig.depthM,
    collectionOriginXM: solver.collectorConfig.originXM, collectionOriginZM: solver.collectorConfig.originZM,
    viewExtentM: .11, onError });
  const current = (): VesselRenderFrame => {
    const snapshot = solver.snapshot();
    return { ...snapshot, emissionStepSeconds: config.fixedDtSeconds,
      collector: { ...solver.collectorConfig, heightM: snapshot.collector.heightM } };
  };
  const initial = current();
  // Independent domain envelope from the supplied physical centreline and
  // collector dimensions; do not reuse the renderer's fit implementation.
  const collector = solver.collectorConfig;
  const rimHeightM = collectorTrayRimHeightM(collector.widthM, collector.depthM);
  const highestWallM = Math.max(Math.max(...frame.curve.getPoints(1024).map(p => p.y)) + geometry.innerRadiusM + geometry.wallThicknessM,
    config.collectionPlaneYM + rimHeightM);
  const framingCornersM: [number, number, number][] = [];
  for (const x of [collector.originXM - COLLECTOR_TRAY_WALL_THICKNESS_M, collector.originXM + collector.widthM + COLLECTOR_TRAY_WALL_THICKNESS_M])
    for (const y of [config.collectionPlaneYM - .00051, highestWallM])
      for (const z of [collector.originZM - COLLECTOR_TRAY_WALL_THICKNESS_M, collector.originZM + collector.depthM + COLLECTOR_TRAY_WALL_THICKNESS_M]) framingCornersM.push([x, y, z]);
  return {
    view, framingCornersM, impactVisibilityDomain: { ...collector, planeYM: config.collectionPlaneYM, rimHeightM },
    physics: () => JSON.stringify(solver.snapshot()), submit: () => view.update(current()),
    submitStale: () => view.update(initial),
    evolve() {
      for (let i = 0; i < 200; i++) {
        const step = solver.step(); if (!step.accepted) throw new Error(step.reason);
      }
      view.update(current());
    },
    mutateCallerFrame() {
      const frame = current(); view.update(frame);
      if (frame.parcels[0]) (frame.parcels[0].positionM as unknown as number[])[0] = NaN;
      if (frame.jets[0]) (frame.jets[0].positionM as unknown as number[])[1] = NaN;
      (frame.collector.heightM as Float64Array).fill(NaN);
      if (frame.breakup.ligaments[0]) (frame.breakup.ligaments[0].points[0]!.positionM as unknown as number[])[0] = NaN;
    },
    invalid: [
      { name: "NaN time", submit: () => view.update({ ...current(), timeSeconds: NaN }) },
      { name: "negative time", submit: () => view.update({ ...current(), timeSeconds: -1 }) },
      { name: "negative inventory", submit: () => view.update({ ...current(), vesselVolumeM3: -1 }) },
      { name: "invalid emission cadence", submit: () => view.update({ ...current(), emissionStepSeconds: 0 }) },
      { name: "NaN ligament", submit: () => {
        const frame = clone(current());
        if (!frame.breakup.ligaments.length) throw new Error("Expected coherent jet near outlet");
        (frame.breakup.ligaments[0]!.points[0]!.positionM as unknown as number[])[0] = NaN; view.update(frame);
      } },
      { name: "NaN collector height", submit: () => {
        const frame = clone(current()); (frame.collector.heightM as Float64Array)[4] = NaN; view.update(frame);
      } },
      ...[0, Math.floor(collector.nx / 2)].map(index => ({
        name: `collector height above finite rim at boundary cell ${index}`, submit: () => {
          const frame = clone(current()); (frame.collector.heightM as Float64Array)[index] = rimHeightM + 1e-6;
          view.update(frame);
        },
      })),
    ],
  };
}

export async function bloodExperimentRendererBench() {
  const checks: Check[] = [], errors: string[] = [], captures: Capture[] = [];
  const check = (name: string, passed: boolean, details?: unknown) =>
    checks.push({ name, passed, ...(details === undefined ? {} : { details }) });
  let precedingCanvas: HTMLCanvasElement | undefined;
  for (const kind of ["tank", "vessel"] as const) {
    let host: HTMLDivElement | undefined, owned: View | undefined;
    const reported: string[] = [];
    try {
      host = document.createElement("div"); host.style.cssText = "position:relative;width:640px;height:400px";
      document.body.appendChild(host);
      const subject = fixture(kind, host, message => reported.push(message)), view = owned = subject.view;
      const canvas = view.canvas, gl = canvas.getContext("webgl2");
      if (!gl) throw new Error("WebGL2 is unavailable");
      const source = getSceneRecordingSource(canvas);
      if (!source) throw new Error("Native capture source is not registered");
      check(`${kind}: source registration belongs to this live canvas`,
        canvas.isConnected && host.childElementCount === 1 && source.kind === "scene"
        && (!precedingCanvas || !getSceneRecordingSource(precedingCanvas)));

      // Observe actual WebGL uploads through the public context, without
      // depending on renderer-private scenes or adding product-only test hooks.
      let uploads = 0, floatValues = 0, finiteBuffers = true;
      const inspect = (args: unknown[]) => {
        uploads++;
        for (const arg of args) if (arg instanceof Float32Array || arg instanceof Float64Array) {
          floatValues += arg.length;
          for (const value of arg) if (!Number.isFinite(value)) finiteBuffers = false;
        }
      };
      const originalData = gl.bufferData, originalSub = gl.bufferSubData;
      gl.bufferData = ((...args: unknown[]) => {
        inspect(args); return Reflect.apply(originalData, gl, args);
      }) as typeof gl.bufferData;
      gl.bufferSubData = ((...args: unknown[]) => {
        inspect(args); return Reflect.apply(originalSub, gl, args);
      }) as typeof gl.bufferSubData;
      const render = () => {
        view.render(); gl.finish();
        for (let i = 0; i < 8; i++) {
          const code = gl.getError(); if (code === gl.NO_ERROR) break;
          errors.push(`${kind}: WebGL error ${code}`);
        }
      };
      const pixels = () => {
        render(); const data = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data); return data;
      };
      const hash = (data = pixels()) => {
        let value = 2166136261;
        for (const byte of data) value = Math.imul(value ^ byte, 16777619);
        return value >>> 0;
      };
      const capture = (name: string) => {
        render(); captures.push({ name: `${kind}-${name}`, dataUrl: canvas.toDataURL("image/png") });
      };
      subject.submit(); await layoutFrame(); render();
      const domainProjection = () => {
        const state = view.visualState, p = state.cameraProjection;
        const rotation = new Quaternion().fromArray(state.cameraQuaternion).invert();
        const origin = new Vector3().fromArray(state.cameraPosition);
        const tangent = Math.tan(p.verticalFieldOfViewDegrees * Math.PI / 360) / state.cameraZoom;
        return (subject.framingCornersM ?? []).map(point => {
          const local = new Vector3(...point).multiplyScalar(1000).sub(origin).applyQuaternion(rotation), depthM = -local.z / 1000;
          return { x: local.x / (-local.z * tangent * p.aspect), y: local.y / (-local.z * tangent),
            depthValid: depthM >= p.nearM && depthM <= p.farM };
        });
      };
      const domainFits = () => {
        const points = domainProjection();
        return points.length === 8 && points.every(p => p.depthValid && Math.abs(p.x) <= .91 && p.y >= -.91 && p.y <= .68);
      };
      if (subject.framingCornersM) {
        const accepted = subject.physics();
        for (const [width, height] of [[640, 400], [960, 540], [640, 640], [320, 640]]) {
          host.style.width = `${width}px`; host.style.height = `${height}px`; await layoutFrame();
          canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })); render();
          check(`${kind}: ${width}×${height} overview contains vessel and collector outside the caption`,
            domainFits() && subject.physics() === accepted, domainProjection());
          if (subject.impactVisibilityDomain) {
            const d = subject.impactVisibilityDomain;
            const point = new Vector3(d.originXM + d.widthM / 2, d.planeYM, d.originZM + d.depthM - .02);
            const ray = new Vector3().fromArray(view.visualState.cameraPosition).multiplyScalar(.001).sub(point);
            const tx = Math.abs(ray.x) < 1e-12 ? Infinity
              : ((ray.x > 0 ? d.originXM + d.widthM : d.originXM) - point.x) / ray.x;
            const tz = Math.abs(ray.z) < 1e-12 ? Infinity
              : ((ray.z > 0 ? d.originZM + d.depthM : d.originZM) - point.z) / ray.z;
            const rimClearanceM = point.y + Math.min(tx, tz) * ray.y - d.planeYM - d.rimHeightM;
            check(`${kind}: ${width}×${height} overview sees the near-edge impact over the real rim`,
              rimClearanceM > 0, { rimClearanceM, pointM: point.toArray() });
          }
        }
        host.style.width = "640px"; host.style.height = "400px"; await layoutFrame();
        canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })); render();
      }
      const initialHash = hash(), initialPhysics = subject.physics();
      for (let i = 0; i < 12; i++) render();
      check(`${kind}: repeated rendering cannot integrate the physical state`, subject.physics() === initialPhysics);
      check(`${kind}: idle display avoids redundant draws`, !view.needsRender);
      subject.evolve();
      const evolvedHash = hash(), physical = subject.physics(), visible = JSON.stringify(view.visualState);
      check(`${kind}: accepted physical evolution changes actual pixels and advances visible time`,
        evolvedHash !== initialHash && view.visualState.timeSeconds > 0, { initialHash, evolvedHash });
      capture("accepted");
      subject.submitStale();
      check(`${kind}: stale snapshots cannot replace the accepted frame`,
        JSON.stringify(view.visualState) === visible && hash() === evolvedHash);
      subject.mutateCallerFrame();
      check(`${kind}: caller mutation cannot poison owned geometry`,
        subject.physics() === physical && JSON.stringify(view.visualState) === visible && hash() === evolvedHash);
      for (const invalid of subject.invalid) {
        let rejected = false;
        try { invalid.submit(); } catch (error) { rejected = error instanceof RangeError; }
        check(`${kind}: ${invalid.name} is rejected transactionally`,
          rejected && subject.physics() === physical && JSON.stringify(view.visualState) === visible && hash() === evolvedHash);
      }

      const appearance = { illumination: "studio" as const, exposureEV: 0, referencePatch: false,
        wallDetail: false, oxygenationFraction: 1 };
      view.setAppearance(appearance); render();
      const baseline = hash(), baseVisible = JSON.stringify(view.visualState);
      for (const change of [
        { name: "camera illumination", value: { illumination: "camera" as const } },
        { name: "negative exposure", value: { exposureEV: -1 } },
        { name: "positive exposure", value: { exposureEV: 1 } },
        { name: "neutral reference patch", value: { referencePatch: true } },
        { name: "deoxygenated optical material", value: { oxygenationFraction: 0 } },
        ...(kind === "vessel" ? [{ name: "wall shading detail", value: { wallDetail: true } }] : []),
      ]) {
        view.setAppearance({ ...appearance, ...change.value });
        const changed = hash();
        check(`${kind}: ${change.name} changes actual pixels without advancing physics`,
          changed !== baseline && subject.physics() === physical && view.visualState.timeSeconds > 0,
          { baseline, changed });
        capture(change.name.replaceAll(" ", "-"));
        view.setAppearance(appearance);
        check(`${kind}: ${change.name} is reversibly applied`, hash() === baseline);
      }
      for (const change of [{ exposureEV: NaN }, { exposureEV: 2.01 }, { oxygenationFraction: -1 },
        { oxygenationFraction: Infinity }, { illumination: "unknown" }]) {
        let rejected = false;
        try { view.setAppearance(change as Parameters<typeof view.setAppearance>[0]); }
        catch (error) { rejected = error instanceof RangeError; }
        check(`${kind}: invalid appearance is rejected before mutation`, rejected
          && JSON.stringify(view.visualState) === baseVisible && hash() === baseline
          && subject.physics() === physical, change);
      }
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
      const cameraHash = hash();
      check(`${kind}: camera input changes the framebuffer, not the simulation`,
        cameraHash !== baseline && subject.physics() === physical);
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
      check(`${kind}: Home restores the initial camera image`, hash() === baseline);
      for (const approachKey of ["+", "="]) {
        const distance = () => new Vector3().fromArray(view.visualState.cameraPosition)
          .distanceTo(new Vector3().fromArray(view.visualState.cameraTarget)) / 1000;
        const before = distance();
        canvas.dispatchEvent(new KeyboardEvent("keydown", { key: approachKey, bubbles: true, cancelable: true }));
        const approached = distance();
        canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "-", bubbles: true, cancelable: true }));
        const restored = distance();
        check(`${kind}: ${approachKey} approaches and minus reverses without advancing accepted state`,
          approached < before && restored > approached && Math.abs(restored / before - 1) < 1e-12 &&
          subject.physics() === physical, { beforeM: before, approachedM: approached, restoredM: restored });
      }
      // Restore the exact authored pose before subsequent pixel-equality gates.
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })); render();
      const overview = JSON.stringify(view.visualState);
      const cameraPosition = JSON.stringify(view.visualState.cameraPosition);
      view.setInspectionView("detail");
      check(`${kind}: material inspection changes lens framing without moving light or physics`,
        hash() !== baseline && subject.physics() === physical && view.visualState.cameraZoom > 1
        && JSON.stringify(view.visualState.cameraPosition) === cameraPosition);
      const detailState = JSON.stringify(view.visualState); let invalidView = false;
      try { view.setInspectionView("invalid" as "detail"); } catch (error) { invalidView = error instanceof RangeError; }
      check(`${kind}: invalid inspection view is rejected without mutation`,
        invalidView && JSON.stringify(view.visualState) === detailState);
      view.setInspectionView("overview");
      check(`${kind}: overview restores exact prior framing`, hash() === baseline && JSON.stringify(view.visualState) === overview);
      view.setInspectionView("detail");
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
      check(`${kind}: Home resets lens magnification and overview`, hash() === baseline && view.visualState.cameraZoom === 1);

      for (const target of [{ width: 0, height: 720, fps: 30 }, { width: 1280.5, height: 720, fps: 30 },
        { width: 9000, height: 720, fps: 30 }, { width: 1280, height: 720, fps: NaN }]) {
        const before = [canvas.width, canvas.height]; let rejected = false;
        try { source.prepare({ ...target, signal: new AbortController().signal }); } catch { rejected = true; }
        check(`${kind}: invalid native-capture target leaves the display unchanged`,
          rejected && !canvas.dataset.sceneRecordingActive && canvas.width === before[0] && canvas.height === before[1], target);
      }
      for (const quality of [{ name: "HD", width: 1280, height: 720 }, { name: "4K", width: 3840, height: 2160 }]) {
        const abort = new AbortController(), lease = source.prepare({ ...quality, fps: 30, signal: abort.signal });
        try {
          render();
          check(`${kind}: ${quality.name} uses exact native dimensions`,
            canvas.width === quality.width && canvas.height === quality.height && canvas.dataset.sceneRecordingActive === "true");
          if (subject.framingCornersM)
            check(`${kind}: ${quality.name} overview keeps the physical domain and impact region visible`, domainFits(), domainProjection());
          if (quality.name === "4K") {
            view.setAppearance({ illumination: "camera", exposureEV: 0, referencePatch: false, wallDetail: true, oxygenationFraction: .98 });
            view.setInspectionView("detail"); capture("material-detail-native4k");
            check(`${kind}: native 4K material inspection preserves physical state and capture dimensions`,
              canvas.width === 3840 && canvas.height === 2160 && subject.physics() === physical);
            view.setInspectionView("overview");
          }
          let rejected = false;
          try { source.prepare({ width: 640, height: 360, fps: 30, signal: new AbortController().signal }); } catch { rejected = true; }
          check(`${kind}: a second capture cannot take ownership`,
            rejected && canvas.width === quality.width && canvas.height === quality.height);
          host.style.width = "333px"; host.style.height = "260px"; await layoutFrame(); render();
          check(`${kind}: host resize cannot resize an active recording`,
            canvas.width === quality.width && canvas.height === quality.height);
          view.setAppearance({ illumination: "camera", exposureEV: -.5, referencePatch: true });
          render();
          check(`${kind}: appearance changes preserve native dimensions and accepted physical state`,
            canvas.width === quality.width && canvas.height === quality.height && subject.physics() === physical);
          abort.abort(); lease.restore(); await layoutFrame(); render();
          const expected = [Math.floor(host.clientWidth * Math.min(devicePixelRatio, 2)),
            Math.floor(host.clientHeight * Math.min(devicePixelRatio, 2))];
          check(`${kind}: abort and repeated restore recover current host size`,
            !canvas.dataset.sceneRecordingActive && canvas.width === expected[0] && canvas.height === expected[1],
            { expected, actual: [canvas.width, canvas.height] });
          view.setAppearance(appearance);
        } finally { abort.abort(); lease.restore(); }
      }
      const cancelled = new AbortController(); cancelled.abort(); let cancelledRejected = false;
      try { source.prepare({ width: 1280, height: 720, fps: 30, signal: cancelled.signal }); } catch { cancelledRejected = true; }
      check(`${kind}: already aborted capture never acquires a lease`, cancelledRejected && !canvas.dataset.sceneRecordingActive);
      check(`${kind}: all actual uploaded floating-point buffers are finite`, finiteBuffers && uploads > 0 && floatValues > 0,
        { uploads, floatValues });
      gl.bufferData = originalData; gl.bufferSubData = originalSub;
      check(`${kind}: normal rendering has no reported resource errors`, reported.length === 0, [...reported]);

      const extension = gl.getExtension("WEBGL_lose_context");
      if (!extension) throw new Error("WEBGL_lose_context is required for the lifecycle gate");
      const abort = new AbortController(), lease = source.prepare({ width: 1280, height: 720, fps: 30, signal: abort.signal });
      const lost = sleepEvent(canvas, "webglcontextlost"); extension.loseContext(); await lost;
      const lostState = JSON.stringify(view.visualState);
      let unavailable = false;
      try { source.prepare({ width: 640, height: 360, fps: 30, signal: new AbortController().signal }); } catch { unavailable = true; }
      subject.submit(); view.render();
      check(`${kind}: real context loss stops draws and blocks new capture`,
        reported.length === 1 && view.visualState.contextLost && !view.needsRender && unavailable
        && JSON.stringify(view.visualState) === lostState && subject.physics() === physical);
      view.dispose(); abort.abort(); lease.restore(); view.dispose();
      check(`${kind}: dispose during a lost-context capture releases source, lease and DOM`,
        !getSceneRecordingSource(canvas) && !canvas.isConnected && !canvas.dataset.sceneRecordingActive
        && host.childElementCount === 0 && !view.needsRender);
      precedingCanvas = canvas;
      const disposedState = JSON.stringify(view.visualState);
      subject.submit(); view.render();
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
      check(`${kind}: stale frames and camera input cannot revive disposed resources`,
        JSON.stringify(view.visualState) === disposedState && !view.needsRender && subject.physics() === physical);
    } catch (error) {
      errors.push(`${kind}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      check(`${kind}: complete lifecycle gate`, false);
    } finally { owned?.dispose(); host?.remove(); }
  }
  return {
    status: checks.length > 0 && checks.every(item => item.passed) && errors.length === 0 ? "PASS" : "FAIL",
    checks, errors, captures, devicePixelRatio,
    limitation: "Actual WebGL/presentation/capture ownership only. No photo-realism, patient-specific optics, 3D splash or calibrated camera-colour claim.",
  };
}
