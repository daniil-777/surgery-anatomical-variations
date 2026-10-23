/** Explicit development-only renderer checks. Imported by the browser test
 * harness, never by the application. This verifies visual field transport and
 * resource ownership; it is not an arterial-flow or clinical validation.
 */
import { ArteryRenderer, type ArteryVelocityFrame } from "./renderer";
import { getSceneRecordingSource } from "../../sceneRecordingSource";

type Check = { name: string; passed: boolean; details?: unknown };
const maximumDifference = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length ? a.reduce((maximum, value, i) => Math.max(maximum, Math.abs(value - b[i]!)), 0) : Infinity;
const layoutFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export async function arteryRendererBench() {
  const radiusM = .002, lengthM = .04, errors: string[] = [], checks: Check[] = [];
  const check = (name: string, passed: boolean, details?: unknown) => {
    checks.push({ name, passed, ...(details === undefined ? {} : { details }) });
  };
  let host: HTMLDivElement | undefined, ownedView: ArteryRenderer | undefined;
  let physicalChecksComplete = false;
  try {
    host = document.createElement("div");
    host.style.cssText = "position:relative;width:640px;height:400px";
    document.body.appendChild(host);
    const view = ownedView = new ArteryRenderer(host, { radiusM, lengthM, onError: message => errors.push(message) });
    const canvas = view.canvas, gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("Artery renderer did not create its WebGL2 context");
    const source = getSceneRecordingSource(canvas);
    if (!source) throw new Error("Artery native recording source was not registered");
    const render = () => {
      view.render(); gl.finish();
      // Drain a bounded number of errors so a failed driver cannot hang a test.
      for (let i = 0; i < 8; ++i) {
        const error = gl.getError(); if (error === gl.NO_ERROR) break;
        errors.push(`WebGL error ${error}`);
      }
    };
    const frame = (timeSeconds: number, axialVelocityMS: ArrayLike<number> = [.002, .002]): ArteryVelocityFrame => ({
      timeSeconds, radialCentresM: [0, radiusM * .99], axialVelocityMS,
    });
    const physicalState = () => {
      const state = view.visualState;
      return { timeSeconds: state.timeSeconds, tracerWraps: state.tracerWraps, tracerCount: state.tracerCount,
        tracerAxialMetres: state.tracerAxialMetres, maximumSpeedMS: state.maximumSpeedMS };
    };
    const serialized = () => JSON.stringify(physicalState());
    view.update(frame(0)); render();
    await layoutFrame(); render();
    check("initial renderer and native source available", canvas.isConnected && source.kind === "scene" && !view.visualState.contextLost);
    check("idle view does not request redundant rendering", !view.needsRender);
    const initial = view.visualState, dt = .01, speed = .002;
    view.update(frame(dt), dt);
    const translated = view.visualState;
    const uniformError = maximumDifference(translated.tracerAxialMetres, initial.tracerAxialMetres.map(x => x + speed * dt));
    check("uniform axial transport uses metres and simulation seconds", uniformError < 1e-13,
      { speedMS: speed, dtSeconds: dt, expectedDisplacementM: speed * dt, maximumErrorM: uniformError });

    // A strictly linear radial profile is an independent field fixture:
    // all tracer displacements must lie between its endpoint velocities, and
    // outer and central streamlines must travel at different speeds.
    const radialVelocity = [.003, .001], radialBefore = translated.tracerAxialMetres;
    view.update(frame(2 * dt, radialVelocity), dt);
    const radialAfter = view.visualState.tracerAxialMetres;
    const inferredSpeeds = radialAfter.map((x, i) => (x - radialBefore[i]!) / dt);
    const minSpeed = Math.min(...inferredSpeeds), maxSpeed = Math.max(...inferredSpeeds);
    check("radial velocity differences affect passive tracer transport",
      minSpeed > .001 && maxSpeed < .003 && maxSpeed - minSpeed > .001,
      { minimumObservedMS: minSpeed, maximumObservedMS: maxSpeed });
    render();
    const paused = serialized();
    view.update(frame(2 * dt, radialVelocity), 1);
    check("repeated timestamp never advances tracers", serialized() === paused && !view.needsRender);
    view.update(frame(dt, [-.9, -.9]), 1);
    check("older frame cannot replace profile or tracer state", serialized() === paused && !view.needsRender);
    const beforeExplicitPause = view.visualState.tracerAxialMetres;
    view.update(frame(3 * dt, radialVelocity), 0);
    check("explicit zero dt pauses advection", maximumDifference(beforeExplicitPause, view.visualState.tracerAxialMetres) === 0);
    const reverseBefore = view.visualState.tracerAxialMetres;
    view.update(frame(4 * dt, [-speed, -speed]), dt);
    const reverseError = maximumDifference(view.visualState.tracerAxialMetres, reverseBefore.map(x => x - speed * dt));
    check("negative physical velocity reverses transport", reverseError < 1e-13, { maximumErrorM: reverseError });

    // Recycle exactly three vessel lengths; this changes visualization positions
    // periodically, never particle count, solver volume or solver mass.
    for (const direction of [1, -1]) {
      const before = view.visualState, velocity = direction * lengthM, elapsed = 3;
      view.update(frame(before.timeSeconds + elapsed, [velocity, velocity]), elapsed);
      const after = view.visualState;
      const error = maximumDifference(after.tracerAxialMetres, before.tracerAxialMetres);
      check(`${direction > 0 ? "forward" : "reverse"} full-wrap recycling preserves tracer count`,
        error < 1e-12 && after.tracerCount === before.tracerCount && after.tracerWraps - before.tracerWraps === 3 * before.tracerCount
        && after.tracerAxialMetres.every(x => x >= -lengthM / 2 && x < lengthM / 2),
        { wrapsAdded: after.tracerWraps - before.tracerWraps, tracerCount: after.tracerCount, maximumErrorM: error });
    }

    const validTime = view.visualState.timeSeconds;
    const invalidCases: { name: string; value: ArteryVelocityFrame; dt?: number }[] = [
      { name: "negative simulation time", value: frame(-1) },
      { name: "NaN simulation time", value: frame(NaN) },
      { name: "negative dt", value: frame(validTime + .01), dt: -.01 },
      { name: "NaN dt", value: frame(validTime + .01), dt: NaN },
      { name: "NaN velocity", value: frame(validTime + .01, [NaN, 0]) },
      { name: "negative radial coordinate", value: { ...frame(validTime + .01), radialCentresM: [-.001, .001] } },
      { name: "non-monotonic radii", value: { ...frame(validTime + .01), radialCentresM: [.001, .0005] } },
      { name: "radius outside lumen", value: { ...frame(validTime + .01), radialCentresM: [0, radiusM] } },
      { name: "unequal array lengths", value: frame(validTime + .01, [.001]) },
      { name: "NaN displacement integral", value: { ...frame(validTime + .01), axialDisplacementM: [0, NaN] } },
      { name: "unequal displacement integral length", value: { ...frame(validTime + .01), axialDisplacementM: [0] } },
    ];
    for (const invalid of invalidCases) {
      const before = serialized(); let rejected = false;
      try { view.update(invalid.value, invalid.dt); } catch (error) { rejected = error instanceof RangeError; }
      check(`invalid ${invalid.name} rejected atomically`, rejected && serialized() === before);
    }
    const inputVelocity = new Float64Array([speed, speed]), inputRadii = new Float64Array([0, radiusM * .99]);
    view.update({ timeSeconds: validTime, axialVelocityMS: inputVelocity, radialCentresM: inputRadii }, 0);
    const copiedProfile = serialized(); inputVelocity.fill(NaN); inputRadii.fill(-1);
    check("renderer does not retain mutable input arrays", serialized() === copiedProfile);
    const cameraBefore = serialized();
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-", "Home"]) {
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true }));
      check(`camera key ${key} invalidates only presentation`, view.needsRender && serialized() === cameraBefore);
      render();
    }
    for (const approachKey of ["+", "="]) {
      const before = view.cameraDistanceM;
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: approachKey, cancelable: true, bubbles: true }));
      const approached = view.cameraDistanceM;
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "-", cancelable: true, bubbles: true }));
      const restored = view.cameraDistanceM;
      check(`camera ${approachKey} approaches and minus reverses without transporting blood`,
        approached < before && restored > approached && Math.abs(restored / before - 1) < 1e-12 &&
        serialized() === cameraBefore, { beforeM: before, approachedM: approached, restoredM: restored });
      render();
    }
    for (const mode of ["blood", "velocity"] as const) for (const cutaway of [true, false]) {
      view.setDisplay(mode, cutaway); render();
      check(`${mode} ${cutaway ? "cutaway" : "whole tube"} preserves field and tracer state`, serialized() === cameraBefore);
    }
    for (const direction of [1, -1]) {
      let reference: ReturnType<typeof physicalState> | undefined;
      for (const groupSize of [1, 8, 64]) {
        const groupHost = document.createElement("div");
        groupHost.style.cssText = "position:relative;width:320px;height:200px";
        document.body.appendChild(groupHost);
        let grouped: ArteryRenderer | undefined;
        try {
          grouped = new ArteryRenderer(groupHost, { radiusM, lengthM, onError: message => errors.push(message) });
          const radii = [0, radiusM * .99], stepDt = .004, steps = 64;
          let consumedOnce = true;
          grouped.update({ radialCentresM: radii, axialVelocityMS: [0, 0], timeSeconds: 0 });
          for (let first = 0; first < steps; first += groupSize) {
            const integral = new Float64Array(2);
            let finalVelocity = [0, 0];
            for (let step = first; step < first + groupSize; ++step) {
              // Reverses four times in each direction; a final-velocity × batch
              // dt shortcut therefore cannot reproduce this accepted sequence.
              const amplitude = direction * (.4 * Math.sin(2 * Math.PI * (step + .25) / 16) + .025);
              finalVelocity = [amplitude, amplitude * .01];
              integral[0] = integral[0]! + finalVelocity[0]! * stepDt;
              integral[1] = integral[1]! + finalVelocity[1]! * stepDt;
            }
            const timeSeconds = (first + groupSize) * stepDt;
            grouped.update({ radialCentresM: radii, axialVelocityMS: finalVelocity, axialDisplacementM: integral, timeSeconds }, groupSize * stepDt);
            const pausedPosition = grouped.visualState.tracerAxialMetres;
            grouped.update({ radialCentresM: radii, axialVelocityMS: finalVelocity, axialDisplacementM: integral, timeSeconds }, groupSize * stepDt);
            consumedOnce = consumedOnce && maximumDifference(pausedPosition, grouped.visualState.tracerAxialMetres) === 0;
          }
          const state = grouped.visualState;
          if (!reference) reference = state;
          const error = maximumDifference(state.tracerAxialMetres, reference.tracerAxialMetres);
          check(`integral grouped ${groupSize} for ${direction > 0 ? "forward" : "reverse"} sequence is consumed once`, consumedOnce);
          check(`accepted-step integral is batching-independent for ${direction > 0 ? "forward" : "reverse"} sequence grouped ${groupSize}`,
            error < 1e-12 && state.tracerCount === reference.tracerCount,
            { groupSize, maximumErrorM: error, tracerCount: state.tracerCount });
        } finally { grouped?.dispose(); groupHost.remove(); }
      }
    }
    physicalChecksComplete = true;
    const displayWidth = () => Math.floor(host!.clientWidth * Math.min(devicePixelRatio, 2));
    const displayHeight = () => Math.floor(host!.clientHeight * Math.min(devicePixelRatio, 2));
    for (const quality of [{ label: "HD", width: 1280, height: 720 }, { label: "4K", width: 3840, height: 2160 }]) {
      const abort = new AbortController(), before = serialized();
      const lease = source.prepare({ ...quality, fps: 30, signal: abort.signal });
      try {
        render();
        check(`${quality.label} lease uses exact native dimensions`, canvas.width === quality.width && canvas.height === quality.height
          && canvas.dataset.sceneRecordingActive === "true");
        let rejected = false;
        try { source.prepare({ width: 640, height: 360, fps: 30, signal: new AbortController().signal }); } catch { rejected = true; }
        check(`${quality.label} concurrent lease rejected without resize`, rejected && canvas.width === quality.width && canvas.height === quality.height);
        host.style.width = quality.label === "HD" ? "333px" : "510px";
        host.style.height = quality.label === "HD" ? "250px" : "330px";
        await layoutFrame(); render();
        check(`${quality.label} host resize preserves recording buffer`, canvas.width === quality.width && canvas.height === quality.height);
        abort.abort(); lease.restore(); await layoutFrame(); render();
        check(`${quality.label} abort restores display dimensions`, !canvas.dataset.sceneRecordingActive
          && canvas.width === displayWidth() && canvas.height === displayHeight(),
        { actual: [canvas.width, canvas.height], expected: [displayWidth(), displayHeight()] });
        check(`${quality.label} capture transitions preserve physical state`, serialized() === before);
      } finally { abort.abort(); lease.restore(); }
    }
    const aborted = new AbortController(); aborted.abort();
    let abortedRejected = false;
    try { source.prepare({ width: 1280, height: 720, fps: 30, signal: aborted.signal }); } catch { abortedRejected = true; }
    check("pre-aborted capture cannot acquire native canvas", abortedRejected && !canvas.dataset.sceneRecordingActive);
    const finalAbort = new AbortController();
    const finalLease = source.prepare({ width: 1280, height: 720, fps: 30, signal: finalAbort.signal });
    render(); view.dispose(); finalAbort.abort(); finalLease.restore(); view.dispose();
    check("dispose during capture removes registration and owned canvas", !getSceneRecordingSource(canvas)
      && !canvas.dataset.sceneRecordingActive && host.childElementCount === 0 && !canvas.isConnected && !view.needsRender);
    const disposedState = serialized();
    view.update(frame(validTime + 100)); view.setDisplay("blood", true); view.render();
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    check("disposed renderer ignores stale updates and camera events", serialized() === disposedState && !view.needsRender);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    check("renderer benchmark completes without resource/API exception", false);
  } finally {
    ownedView?.dispose(); host?.remove();
  }
  return {
    status: checks.length > 0 && checks.every(value => value.passed) && !errors.length ? "PASS" : "FAIL",
    checks, errors, devicePixelRatio, physicalChecksComplete,
    limitation: "Renderer and visualization lifecycle only. Tracer recycling does not represent physical arterial mass transport; no clinical realism or encoded-video quality claim.",
  };
}
