// The development test lab (px-test-lab.html): a counter, a note, a view angle and two attachments, plus the lab-session
// adapter the platform talks to. It exists so the editor's end-to-end tests and the lab host check can drive every
// behaviour of the contract themselves: busy reasons, exact / inexact / slow / failing restores, local-only files,
// exports with and without research-only rights. Development only: nothing in the production build imports it.

import {
  LAB_SESSION_PROTOCOL,
  type LabExportAction,
  type LabLibraryExport,
  type LabRestoreContext,
  type LabRestoreReport,
  type LabSessionAdapter,
  type LabSessionDocument,
  type LabSessionHandle,
} from "../bridge/labSession";

export const TEST_LAB_ID = "test-lab";
export const TEST_LAB_TITLE = "Test Lab";
export const TEST_LAB_SCHEMA = "viscera.test-lab-session/1";
export const PAYLOAD_NAME = "payload.bin";
export const LOCAL_NAME = "local-note.txt";
export const PAYLOAD_BYTES = 4096;
/** Where a test can preset the restore behaviour before the lab loads (the URL parameter testRestore wins). */
export const RESTORE_MODE_STORAGE_KEY = "px-test-lab.restore-mode";

export const RESTORE_MODES = ["exact", "inexact", "slow", "fail"] as const;
export type RestoreMode = (typeof RESTORE_MODES)[number];

export const BUSY_REASONS = ["loading", "running", "exporting"] as const;
export type TestBusyReason = (typeof BUSY_REASONS)[number];

/** A type alias (not an interface), so it is assignable to the bridge's JsonValue. */
export type TestLabState = {
  counter: number;
  note: string;
  /** A uint64 kept as a decimal string, as the contract asks for integers above 2^53. */
  seed: string;
  view: { angle: number };
  /** The note is also kept as a local-only attachment (local-note.txt) that never leaves the device. */
  keepLocalFile: boolean;
};

export type TestLabPhase = "pending" | "restoring" | "ready";
export type TestLabStart = "restored" | "fresh" | "standalone";

export interface TestLabRestoreRecord {
  counter: number;
  exact: boolean;
  missingLocal: string[];
  warnings: string[];
}

export interface TestLabSnapshot {
  phase: TestLabPhase;
  start: TestLabStart | null;
  state: TestLabState;
  busy: false | TestBusyReason;
  /** canvas[data-scene-recording-active="true"]: the scene recorder's flag, which the host also treats as busy. */
  sceneRecording: boolean;
  restoreMode: RestoreMode;
  restores: TestLabRestoreRecord[];
  startFreshCalls: number;
  changes: { document: number; view: number };
  /** Local-only files the platform said this device does not have. */
  missingLocal: string[];
  lastWarnings: string[];
}

export const DEFAULT_STATE: TestLabState = {
  counter: 0,
  note: "",
  seed: "18446744073709551557",
  view: { angle: 0 },
  keepLocalFile: false,
};

const EXPORT_CLAIMS = {
  evidence: "A still the development test lab drew from its counter and note.",
  limitations: ["Synthetic test content: not anatomy, not a measurement."],
};

/** The payload attachment's bytes for a counter value (deterministic, so tests can check them byte for byte). */
export function payloadBytes(counter: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(PAYLOAD_BYTES);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (counter * 131 + index * 7) & 0xff;
  return bytes;
}

/** The local-only attachment's text for a note. */
export function localNoteText(note: string): string {
  return `Test Lab local note\n${note}\n`;
}

export function isRestoreMode(value: unknown): value is RestoreMode {
  return typeof value === "string" && (RESTORE_MODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The saved state, checked field by field (a restore never trusts a document's shape). */
export function parseTestLabState(value: unknown): TestLabState {
  if (!isRecord(value)) throw new Error("The Test Lab state is not an object.");
  const { counter, note, seed, view, keepLocalFile } = value;
  if (typeof counter !== "number" || !Number.isSafeInteger(counter)) throw new Error("The Test Lab counter is not an integer.");
  if (typeof note !== "string") throw new Error("The Test Lab note is not text.");
  if (typeof seed !== "string" || !/^\d{1,20}$/.test(seed)) throw new Error("The Test Lab seed is not a decimal string.");
  if (!isRecord(view) || typeof view.angle !== "number" || !Number.isFinite(view.angle)) throw new Error("The Test Lab view is missing.");
  if (typeof keepLocalFile !== "boolean") throw new Error("The Test Lab local-file switch is missing.");
  return { counter, note, seed, view: { angle: view.angle }, keepLocalFile };
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("The restore was cancelled.");
  error.name = "AbortError";
  return error;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function sameBytes(blob: Blob, bytes: Uint8Array): Promise<boolean> {
  if (blob.size !== bytes.byteLength) return false;
  const read = new Uint8Array(await blob.arrayBuffer());
  for (let index = 0; index < read.length; index++) if (read[index] !== bytes[index]) return false;
  return true;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

/** The lab's state and behaviour switches; the React view and the adapter both work through it. */
export class TestLabModel {
  private snapshot: TestLabSnapshot;
  private readonly listeners = new Set<() => void>();
  private handle: Pick<LabSessionHandle, "changed"> | null = null;
  private canvas: HTMLCanvasElement | null = null;
  // an unchanged attachment is handed over as the same Blob (the platform hashes it once)
  private payloadCache: { counter: number; blob: Blob } | null = null;
  private localCache: { note: string; blob: Blob } | null = null;

  readonly protocol = LAB_SESSION_PROTOCOL;

  constructor(options: { pending: boolean; restoreMode?: RestoreMode | undefined }) {
    this.snapshot = {
      phase: options.pending ? "pending" : "ready",
      start: options.pending ? null : "standalone",
      state: { ...DEFAULT_STATE, view: { ...DEFAULT_STATE.view } },
      busy: false,
      sceneRecording: false,
      restoreMode: options.restoreMode ?? "exact",
      restores: [],
      startFreshCalls: 0,
      changes: { document: 0, view: 0 },
      missingLocal: [],
      lastWarnings: [],
    };
  }

  // store --------------------------------------------------------------------------------------------------------------

  readonly getSnapshot = (): TestLabSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(patch: Partial<TestLabSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** The bridge handle that tells the platform about changes. */
  connect(handle: Pick<LabSessionHandle, "changed">): void {
    this.handle = handle;
  }

  attachCanvas(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
  }

  stageCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  private change(state: TestLabState, kind: "document" | "view"): void {
    const changes = { ...this.snapshot.changes, [kind]: this.snapshot.changes[kind] + 1 };
    this.update({ state, changes });
    this.handle?.changed(kind);
  }

  // what the user (or a test) does -----------------------------------------------------------------------------------

  increment(delta = 1): void {
    const state = this.snapshot.state;
    this.change({ ...state, counter: state.counter + delta }, "document");
  }

  setNote(note: string): void {
    const state = this.snapshot.state;
    if (state.note === note) return;
    this.change({ ...state, note }, "document");
  }

  /** A camera-like change: autosaved, never a version on its own. */
  rotateView(degrees = 30): void {
    const state = this.snapshot.state;
    this.change({ ...state, view: { angle: (state.view.angle + degrees) % 360 } }, "view");
  }

  setKeepLocalFile(keep: boolean): void {
    const state = this.snapshot.state;
    if (state.keepLocalFile === keep) return;
    this.change({ ...state, keepLocalFile: keep }, "document");
  }

  setBusy(reason: false | TestBusyReason): void {
    this.update({ busy: reason });
  }

  setSceneRecording(active: boolean): void {
    this.canvas?.setAttribute("data-scene-recording-active", active ? "true" : "false");
    this.update({ sceneRecording: active });
  }

  setRestoreMode(mode: RestoreMode): void {
    this.update({ restoreMode: mode });
  }

  // attachments --------------------------------------------------------------------------------------------------------

  payload(counter: number): Blob {
    if (this.payloadCache?.counter !== counter) {
      this.payloadCache = { counter, blob: new Blob([payloadBytes(counter)], { type: "application/octet-stream" }) };
    }
    return this.payloadCache.blob;
  }

  localFile(note: string): Blob {
    if (this.localCache?.note !== note) this.localCache = { note, blob: new Blob([localNoteText(note)], { type: "text/plain" }) };
    return this.localCache.blob;
  }

  // the lab-session adapter --------------------------------------------------------------------------------------------

  serialize(): LabSessionDocument<TestLabState> {
    const state = this.snapshot.state;
    const attachments: Record<string, Blob> = { [PAYLOAD_NAME]: this.payload(state.counter) };
    const document: LabSessionDocument<TestLabState> = {
      schema: TEST_LAB_SCHEMA,
      labId: TEST_LAB_ID,
      state: { ...state, view: { ...state.view } },
      attachments,
      versions: { "test-lab": "1.0.0" },
    };
    if (state.keepLocalFile) {
      attachments[LOCAL_NAME] = this.localFile(state.note);
      document.localOnly = [LOCAL_NAME];
    }
    return document;
  }

  async restore(document: LabSessionDocument<TestLabState>, signal: AbortSignal, context?: LabRestoreContext): Promise<LabRestoreReport> {
    if (document.schema !== TEST_LAB_SCHEMA || document.labId !== TEST_LAB_ID) {
      throw new Error("This document is not a Test Lab session.");
    }
    const state = parseTestLabState(document.state);
    const mode = this.snapshot.restoreMode;
    const before = this.snapshot.phase;
    this.update({ phase: "restoring" });
    try {
      if (mode === "slow") await wait(1_500, signal);
      if (signal.aborted) throw abortError(signal);
      if (mode === "fail") throw new Error("The Test Lab refused this document (restore mode: Fail).");
    } catch (error) {
      this.update({ phase: before });
      throw error;
    }
    const warnings: string[] = [];
    const payload = document.attachments?.[PAYLOAD_NAME];
    if (!payload || !(await sameBytes(payload, payloadBytes(state.counter)))) warnings.push("The payload attachment does not match the counter.");
    const missingLocal = (context?.missingLocal ?? []).map((item) => item.name);
    if (missingLocal.includes(LOCAL_NAME)) {
      warnings.push("The local note file is not on this device; the note text was kept.");
    } else if (state.keepLocalFile) {
      const local = document.attachments?.[LOCAL_NAME];
      if (!local || (await local.text()) !== localNoteText(state.note)) warnings.push("The local note file does not match the note.");
    }
    if (mode === "inexact") warnings.push("The animation restarted from its first frame.");
    const exact = warnings.length === 0;
    this.update({
      phase: "ready",
      start: "restored",
      state,
      missingLocal,
      lastWarnings: warnings,
      restores: [...this.snapshot.restores, { counter: state.counter, exact, missingLocal, warnings }],
    });
    return { exact, warnings };
  }

  startFresh(): void {
    this.update({
      phase: "ready",
      start: "fresh",
      state: { ...DEFAULT_STATE, view: { ...DEFAULT_STATE.view } },
      startFreshCalls: this.snapshot.startFreshCalls + 1,
      missingLocal: [],
      lastWarnings: [],
    });
  }

  busy(): false | string {
    return this.snapshot.busy;
  }

  async thumbnail(width: number, height: number): Promise<Blob | null> {
    const source = this.canvas;
    if (!source || !(source.width > 0 && source.height > 0)) return null;
    const output = source.ownerDocument.createElement("canvas");
    output.width = Math.max(1, Math.round(width));
    output.height = Math.max(1, Math.round(height));
    const context = output.getContext("2d");
    if (!context) return null;
    // cover crop, centred
    const scale = Math.max(output.width / source.width, output.height / source.height);
    const cropWidth = output.width / scale;
    const cropHeight = output.height / scale;
    context.drawImage(source, (source.width - cropWidth) / 2, (source.height - cropHeight) / 2, cropWidth, cropHeight, 0, 0, output.width, output.height);
    return canvasBlob(output, "image/webp", 0.86);
  }

  exports(): LabExportAction[] {
    return [
      { id: "snapshot", label: "Add Snapshot to Library", kind: "image", run: (signal) => this.snapshotExport(signal) },
      { id: "research-study", label: "Add Research Study to Library", kind: "shape", run: async () => this.researchExport() },
    ];
  }

  private async snapshotExport(signal: AbortSignal): Promise<LabLibraryExport> {
    const state = this.snapshot.state;
    const data = new Blob([JSON.stringify({ counter: state.counter, note: state.note, seed: state.seed }, null, 2)], { type: "application/json" });
    const files: LabLibraryExport["files"] = [{ filename: "test-lab-state.json", role: "data", blob: data }];
    const still = this.canvas ? await canvasBlob(this.canvas, "image/png") : null;
    if (signal.aborted) throw abortError(signal);
    if (still) files.unshift({ filename: `test-lab-${state.counter}.png`, role: "primary", blob: still });
    return {
      kind: "image",
      title: `Test Lab · ${state.counter}`,
      description: state.note,
      tags: ["test-lab"],
      files,
      thumbnail: await this.thumbnail(640, 400),
      metadata: { counter: state.counter, seed: state.seed },
      claims: { ...EXPORT_CLAIMS, limitations: [...EXPORT_CLAIMS.limitations] },
    };
  }

  private researchExport(): LabLibraryExport {
    return {
      kind: "shape",
      title: "Research study (test fixture)",
      files: [{ filename: "study.json", role: "data", blob: new Blob(['{"fixture":true}'], { type: "application/json" }) }],
      claims: {
        evidence: "A fixture that stands for output under a research-only licence.",
        limitations: ["Synthetic test content."],
        rights: "Research-only test fixture: Add to Library must refuse it.",
      },
    };
  }

  describe(): { title?: string; subtitle?: string } {
    const state = this.snapshot.state;
    return state.note ? { title: `Counter ${state.counter}`, subtitle: state.note } : { title: `Counter ${state.counter}` };
  }

  /** The adapter registered with the bridge (methods bound to this model). */
  adapter(): LabSessionAdapter<TestLabState> {
    return {
      labId: TEST_LAB_ID,
      title: TEST_LAB_TITLE,
      serialize: () => this.serialize(),
      restore: (document, signal, context) => this.restore(document, signal, context),
      startFresh: () => this.startFresh(),
      busy: () => this.busy(),
      thumbnail: (width, height) => this.thumbnail(width, height),
      recordingCanvas: () => this.canvas,
      exports: () => this.exports(),
      describe: () => this.describe(),
    };
  }
}
