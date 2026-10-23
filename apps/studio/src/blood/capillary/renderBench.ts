/** Explicit development-only browser gate. Never imported by the application.
 * Tests renderer/resource ownership, not surgical realism or new fluid physics.
 */
import { CapillaryRenderer } from "./renderer";
import { CapillaryFilmSolver } from "./solver";
import { getSceneRecordingSource } from "../../sceneRecordingSource";

type Check = { name: string; passed: boolean; details?: unknown };
const layoutFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export async function capillaryRendererBench() {
  const errors: string[] = [], checks: Check[] = [];
  const check = (name: string, passed: boolean, details?: unknown) =>
    checks.push({ name, passed, ...(details === undefined ? {} : { details }) });
  let host: HTMLDivElement | undefined, owned: CapillaryRenderer | undefined;
  const initial = Float64Array.from({ length: 96 }, (_, i) =>
    8e-6 + 80e-6 * Math.exp(-Math.pow(((i + .5) / 96 * .004 - .002) / .0008, 4)));
  const solver = new CapillaryFilmSolver({}, initial);
  const physical = () => JSON.stringify(solver.snapshot());
  try {
    host = document.createElement("div"); host.style.cssText = "position:relative;width:640px;height:400px";
    document.body.appendChild(host);
    const view = owned = new CapillaryRenderer(host, {
      lengthM: .004, widthM: .001, onError: message => errors.push(message),
    });
    const canvas = view.canvas, gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("No WebGL2 context");
    const source = getSceneRecordingSource(canvas);
    if (!source) throw new Error("No native recording source");
    const render = () => {
      view.render(); gl.finish();
      for (let i = 0; i < 8; i++) {
        const code = gl.getError(); if (code === gl.NO_ERROR) break;
        errors.push(`WebGL error ${code}`);
      }
    };
    const pixelHash = () => {
      render();
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let hash = 2166136261;
      for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i]!, 16777619);
      return hash >>> 0;
    };
    view.update(solver.snapshot()); await layoutFrame(); render();
    check("renderer registers its native source and owns one canvas",
      canvas.isConnected && host.childElementCount === 1 && source.kind === "scene");
    check("paused renderer does not request redundant draws", !view.needsRender);
    const initialHash = pixelHash(), beforeSimulation = physical();
    for (let i = 0; i < 20; i++) render();
    check("render cadence cannot advance physical state", physical() === beforeSimulation && view.visualState.timeSeconds === 0);
    for (let i = 0; i < 100; i++) {
      const result = solver.step(.005);
      if (!result.accepted) throw new Error(`Physical fixture rejected: ${result.reason}`);
      if ((i + 1) % 8 === 0 || i === 99) view.update(result.snapshot);
    }
    const evolvedHash = pixelHash();
    check("accepted physical evolution updates the displayed geometry",
      view.visualState.timeSeconds === solver.timeSeconds && evolvedHash !== initialHash,
      { timeSeconds: solver.timeSeconds, initialHash, evolvedHash });
    const latest = solver.snapshot(), frozen = physical(), visual = JSON.stringify(view.visualState);
    view.update({ timeSeconds: 0, heightM: initial });
    check("older snapshots cannot replace the accepted visible frame",
      JSON.stringify(view.visualState) === visual && pixelHash() === evolvedHash);
    const mutable = latest.heightM.slice();
    view.update({ timeSeconds: latest.timeSeconds, heightM: mutable });
    const copiedHash = pixelHash(); mutable.fill(NaN);
    check("renderer copies geometry rather than retaining mutable physical arrays", pixelHash() === copiedHash && physical() === frozen);

    for (const invalid of [
      { name: "NaN time", timeSeconds: NaN, heightM: latest.heightM },
      { name: "negative time", timeSeconds: -1, heightM: latest.heightM },
      { name: "NaN height", timeSeconds: latest.timeSeconds + .1, heightM: Float64Array.from(latest.heightM, (_, i) => i ? 8e-6 : NaN) },
      { name: "zero height", timeSeconds: latest.timeSeconds + .1, heightM: new Float64Array(96) },
      { name: "negative height", timeSeconds: latest.timeSeconds + .1, heightM: new Float64Array(96).fill(-8e-6) },
      { name: "too few cells", timeSeconds: latest.timeSeconds + .1, heightM: new Float64Array(7).fill(8e-6) },
      { name: "too many cells", timeSeconds: latest.timeSeconds + .1, heightM: new Float64Array(257).fill(8e-6) },
    ]) {
      let rejected = false;
      try { view.update(invalid); } catch (error) { rejected = error instanceof RangeError; }
      check(`invalid ${invalid.name} rejected without changing the visible or physical state`,
        rejected && JSON.stringify(view.visualState) === visual && pixelHash() === copiedHash && physical() === frozen);
    }
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "-", "Home"]) {
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true, bubbles: true }));
      check(`camera key ${key} changes presentation only`, view.needsRender
        && physical() === frozen && JSON.stringify(view.visualState) === visual);
      render();
    }
    for (const approachKey of ["+", "="]) {
      const before = view.cameraDistanceM;
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: approachKey, cancelable: true, bubbles: true }));
      const approached = view.cameraDistanceM;
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "-", cancelable: true, bubbles: true }));
      const restored = view.cameraDistanceM;
      check(`camera ${approachKey} approaches and minus reverses without changing film`,
        approached < before && restored > approached && Math.abs(restored / before - 1) < 1e-12 &&
        physical() === frozen && JSON.stringify(view.visualState) === visual,
        { beforeM: before, approachedM: approached, restoredM: restored });
      render();
    }
    for (const target of [
      { width: 0, height: 720, fps: 30 }, { width: 1280.5, height: 720, fps: 30 },
      { width: 9000, height: 720, fps: 30 }, { width: 1280, height: 720, fps: 0 },
      { width: 1280, height: 720, fps: NaN },
    ]) {
      const before = [canvas.width, canvas.height]; let rejected = false;
      try { source.prepare({ ...target, signal: new AbortController().signal }); } catch { rejected = true; }
      check("invalid capture target rejected without resize",
        rejected && !canvas.dataset.sceneRecordingActive && canvas.width === before[0] && canvas.height === before[1], target);
    }
    const displaySize = () => [Math.floor(host!.clientWidth * Math.min(devicePixelRatio, 2)),
      Math.floor(host!.clientHeight * Math.min(devicePixelRatio, 2))];
    for (const quality of [{ name: "HD", width: 1280, height: 720 }, { name: "4K", width: 3840, height: 2160 }]) {
      const abort = new AbortController(), lease = source.prepare({ ...quality, fps: 30, signal: abort.signal });
      try {
        render();
        check(`${quality.name} capture leases the exact native buffer`,
          canvas.width === quality.width && canvas.height === quality.height && canvas.dataset.sceneRecordingActive === "true");
        let rejected = false;
        try { source.prepare({ width: 640, height: 360, fps: 30, signal: new AbortController().signal }); } catch { rejected = true; }
        check(`${quality.name} second lease cannot steal or resize the buffer`,
          rejected && canvas.width === quality.width && canvas.height === quality.height);
        host.style.width = quality.name === "HD" ? "333px" : "510px";
        host.style.height = quality.name === "HD" ? "250px" : "330px";
        await layoutFrame(); render();
        check(`${quality.name} host resize preserves recording dimensions`,
          canvas.width === quality.width && canvas.height === quality.height);
        abort.abort(); lease.restore(); await layoutFrame(); render();
        const expected = displaySize();
        check(`${quality.name} abort and repeated restore recover the current display size`,
          !canvas.dataset.sceneRecordingActive && canvas.width === expected[0] && canvas.height === expected[1],
          { actual: [canvas.width, canvas.height], expected });
        check(`${quality.name} capture/abort leaves simulation time and state unchanged`,
          physical() === frozen && JSON.stringify(view.visualState) === visual);
      } finally { abort.abort(); lease.restore(); }
    }
    const cancelled = new AbortController(); cancelled.abort(); let rejected = false;
    try { source.prepare({ width: 1280, height: 720, fps: 30, signal: cancelled.signal }); } catch { rejected = true; }
    check("pre-aborted native recording is rejected", rejected && !canvas.dataset.sceneRecordingActive);
    const finalAbort = new AbortController();
    const finalLease = source.prepare({ width: 1280, height: 720, fps: 30, signal: finalAbort.signal });
    render(); view.dispose(); finalAbort.abort(); finalLease.restore(); view.dispose();
    check("dispose during capture unregisters and removes the canvas",
      !getSceneRecordingSource(canvas) && !canvas.dataset.sceneRecordingActive && !canvas.isConnected
      && host.childElementCount === 0 && !view.needsRender);
    const disposedState = JSON.stringify(view.visualState);
    view.update({ timeSeconds: 1000, heightM: initial }); view.render();
    canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    check("disposed renderer ignores stale frames and input", JSON.stringify(view.visualState) === disposedState && !view.needsRender);
    check("renderer lifecycle never mutates the accepted film", physical() === frozen);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    check("renderer benchmark completes without API/resource exceptions", false);
  } finally {
    owned?.dispose(); host?.remove();
  }
  return {
    status: checks.length > 0 && checks.every(value => value.passed) && errors.length === 0 ? "PASS" : "FAIL",
    checks, errors, devicePixelRatio,
    limitation: "Rendering/native-capture lifecycle only. Physical thin-film validation lives in solver.test.ts; no 3D drop or surgical realism claim.",
  };
}
