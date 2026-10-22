// The development test lab page (px-test-lab.html): renders TestLabModel and registers its adapter through the bridge,
// so the editor's end-to-end tests and the lab host check drive the whole contract (saves, restores, busy reasons,
// local-only files, exports, thumbnails, recording) without a real lab. Development only: not a build input.
import { StrictMode, useEffect, useRef, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { isRestorePending, registerLabSession } from "../bridge/labSession";
import { BUSY_REASONS, RESTORE_MODE_STORAGE_KEY, RESTORE_MODES, TestLabModel, isRestoreMode } from "./testLabModel";

function storedRestoreMode() {
  try {
    const value = window.localStorage.getItem(RESTORE_MODE_STORAGE_KEY);
    return isRestoreMode(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const model = new TestLabModel({ pending: isRestorePending(), restoreMode: storedRestoreMode() });
// the e2e suite drives and inspects the lab through this handle
(window as unknown as { __visceraTestLab?: TestLabModel }).__visceraTestLab = model;

function draw(canvas: HTMLCanvasElement, counter: number, angle: number, note: string): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const { width, height } = canvas;
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#1d2a3a");
  gradient.addColorStop(1, `hsl(${(counter * 37) % 360} 45% 32%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate(width / 2, height / 2);
  context.rotate((angle * Math.PI) / 180);
  context.strokeStyle = "rgba(255,255,255,0.35)";
  context.lineWidth = 6;
  context.beginPath();
  context.moveTo(-width * 0.35, 0);
  context.lineTo(width * 0.35, 0);
  context.stroke();
  context.restore();
  context.fillStyle = "#ffffff";
  context.font = "600 120px -apple-system, Inter, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(counter), width / 2, height / 2);
  context.font = "400 22px -apple-system, Inter, sans-serif";
  context.fillText(note.slice(0, 48), width / 2, height - 40);
}

function TestLab() {
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const handle = registerLabSession(model.adapter());
    model.connect(handle);
    return () => handle.dispose();
  }, []);

  useEffect(() => {
    model.attachCanvas(canvas.current);
    return () => model.attachCanvas(null);
  }, []);

  useEffect(() => {
    if (canvas.current) draw(canvas.current, snapshot.state.counter, snapshot.state.view.angle, snapshot.state.note);
  }, [snapshot.state]);

  const { state } = snapshot;
  return (
    <main style={{ display: "grid", gridTemplateColumns: "1fr 280px", height: "100vh", margin: 0, background: "#11161d", color: "#e8edf2", font: "13px -apple-system, Inter, sans-serif" }}>
      <canvas ref={canvas} width={960} height={600} data-testid="test-lab-canvas" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      <aside style={{ padding: 16, display: "grid", gap: 10, alignContent: "start" }}>
        <h1 style={{ fontSize: 16, margin: 0 }}>Test Lab</h1>
        <p data-testid="test-lab-phase">phase: {snapshot.phase} · start: {snapshot.start ?? "—"}</p>
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" onClick={() => model.increment(-1)}>−1</button>
          <output data-testid="test-lab-counter">{state.counter}</output>
          <button type="button" onClick={() => model.increment(1)}>+1</button>
        </div>
        <label>
          Note <input aria-label="Note" value={state.note} onChange={(event) => model.setNote(event.target.value)} />
        </label>
        <button type="button" onClick={() => model.rotateView(30)}>Rotate view</button>
        <label>
          <input type="checkbox" checked={state.keepLocalFile} onChange={(event) => model.setKeepLocalFile(event.target.checked)} /> Keep the note as a
          local-only file
        </label>
        <label>
          Busy{" "}
          <select aria-label="Busy" value={snapshot.busy || ""} onChange={(event) => model.setBusy(event.target.value === "" ? false : (event.target.value as (typeof BUSY_REASONS)[number]))}>
            <option value="">not busy</option>
            {BUSY_REASONS.map((reason) => (
              <option key={reason} value={reason}>{reason}</option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={snapshot.sceneRecording} onChange={(event) => model.setSceneRecording(event.target.checked)} /> Scene recording flag
        </label>
        <label>
          Restore mode{" "}
          <select aria-label="Restore mode" value={snapshot.restoreMode} onChange={(event) => isRestoreMode(event.target.value) && model.setRestoreMode(event.target.value)}>
            {RESTORE_MODES.map((mode) => (
              <option key={mode} value={mode}>{mode}</option>
            ))}
          </select>
        </label>
        <p data-testid="test-lab-changes">changes: {snapshot.changes.document} document · {snapshot.changes.view} view · restores {snapshot.restores.length} · fresh {snapshot.startFreshCalls}</p>
        {snapshot.missingLocal.length > 0 && <p role="note">Missing local files: {snapshot.missingLocal.join(", ")}</p>}
      </aside>
    </main>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><TestLab /></StrictMode>);
