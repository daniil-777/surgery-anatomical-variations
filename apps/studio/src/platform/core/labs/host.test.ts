import { describe, expect, it, vi } from "vitest";
import {
  LAB_READY_MESSAGE,
  LAB_SESSION_PROTOCOL,
  type LabExportAction,
  type LabSessionAdapter,
  type LabSessionDocument,
  type LabSessionEvent,
  type LabSessionRegistry,
} from "../../bridge/labSession";
import {
  LabBusyError,
  LabDocumentError,
  LabUnavailableError,
  MAX_ATTACHMENTS,
  cloneJson,
  connectLab,
  copyRestoreReport,
  isLabReadyMessage,
  isResearchOnly,
  labReloader,
  normalizeLabDocument,
  normalizeLibraryExport,
  toHostBlob,
  type HostTimers,
  type HostWindow,
  type LabConnectionOptions,
  type LabFrame,
} from "./host";

// Fakes ---------------------------------------------------------------------------------------------------------------

type Listener = (event: unknown) => void;

class FakeTarget {
  private readonly entries: Array<{ type: string; listener: Listener; capture: boolean }> = [];
  addEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }): void {
    const capture = options === true || (typeof options === "object" && options.capture === true);
    this.entries.push({ type, listener, capture });
  }
  removeEventListener(type: string, listener: Listener, options?: boolean | { capture?: boolean }): void {
    const capture = options === true || (typeof options === "object" && options.capture === true);
    const index = this.entries.findIndex((entry) => entry.type === type && entry.listener === listener && entry.capture === capture);
    if (index >= 0) this.entries.splice(index, 1);
  }
  dispatch(type: string, event: unknown = {}): void {
    for (const entry of this.entries.filter((candidate) => candidate.type === type)) entry.listener(event);
  }
  count(type?: string): number {
    return this.entries.filter((entry) => type === undefined || entry.type === type).length;
  }
  captures(type: string): boolean {
    return this.entries.some((entry) => entry.type === type && entry.capture);
  }
}

class FakeLabWindow extends FakeTarget {
  location = { href: "about:blank" };
  __visceraLabSessions?: LabSessionRegistry | undefined;
  structuredClone?: (<T>(value: T) => T) | undefined;
  /** The Navigation API, when a test gives the window one. */
  navigation?: FakeTarget | undefined;
}

class FakeLabDocument extends FakeTarget {
  visibilityState = "visible";
  recording = false;
  constructor(
    readonly URL: string,
    readonly defaultView: FakeLabWindow,
  ) {
    super();
  }
  get baseURI(): string {
    return this.URL;
  }
  querySelector(selector: string): unknown {
    return this.recording && selector.includes("data-scene-recording-active") ? {} : null;
  }
  querySelectorAll(): unknown[] {
    return [];
  }
}

class FakeFrame extends FakeTarget {
  // the WindowProxy of an iframe keeps its identity across navigations
  readonly contentWindow = new FakeLabWindow();
  contentDocument: FakeLabDocument | null = null;
  /** What reload() asked for (the test then plays the navigation). */
  src = "";
  /** A new document commits (scripts may then run); the load event is separate. */
  navigate(url: string, registry: LabSessionRegistry | null): FakeLabDocument {
    const document = new FakeLabDocument(url, this.contentWindow);
    this.contentWindow.location.href = url;
    this.contentWindow.__visceraLabSessions = registry ?? undefined;
    this.contentDocument = document;
    return document;
  }
}

class FakeHost extends FakeTarget {
  readonly location = { origin: "https://example.test" };
  post(data: unknown, source: unknown, origin = this.location.origin): void {
    this.dispatch("message", { data, source, origin });
  }
}

function fakeRegistry(protocol = LAB_SESSION_PROTOCOL) {
  let adapters: LabSessionAdapter[] = [];
  const listeners = new Set<(event: LabSessionEvent) => void>();
  const emit = (event: LabSessionEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const registry: LabSessionRegistry = {
    protocol,
    current: () => adapters[adapters.length - 1] ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    registry,
    listeners,
    emit,
    register(adapter: LabSessionAdapter) {
      adapters.push(adapter);
      emit({ type: "register", labId: adapter.labId, adapter });
      return {
        changed: (kind: "document" | "view" = "document") => emit({ type: "change", labId: adapter.labId, kind }),
        dispose: () => {
          adapters = adapters.filter((candidate) => candidate !== adapter);
          emit({ type: "dispose", labId: adapter.labId });
        },
      };
    },
  };
}

type TestAdapter = LabSessionAdapter & { busyReason: false | string; restored: LabSessionDocument[] };

function fakeAdapter(labId = "organ", overrides: Partial<LabSessionAdapter> = {}): TestAdapter {
  const adapter: TestAdapter = {
    labId,
    title: "Organ Design",
    busyReason: false,
    restored: [],
    serialize: () => ({ schema: "viscera.test/1", labId, state: { value: 1 } }),
    restore: async (document) => {
      adapter.restored.push(document);
      return { exact: true, warnings: [] };
    },
    busy: () => adapter.busyReason,
    ...overrides,
  };
  return adapter;
}

function manualTimers(): HostTimers & { advance(ms: number): Promise<void> } {
  let now = 0;
  let ids = 0;
  let timers: Array<{ id: number; at: number; callback: () => void }> = [];
  return {
    setTimeout(callback, ms) {
      ids += 1;
      timers.push({ id: ids, at: now + ms, callback });
      return ids;
    },
    clearTimeout(handle) {
      timers = timers.filter((timer) => timer.id !== handle);
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        await Promise.resolve();
        const next = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers = timers.filter((timer) => timer !== next);
        now = next.at;
        next.callback();
      }
      now = target;
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

/** A Blob of "another realm": instanceof Blob is false, only the Blob surface exists. */
function foreignBlob(bytes: number[], type = "application/octet-stream") {
  const data = new Uint8Array(bytes);
  const read = vi.fn(async () => data.buffer.slice(0));
  return { size: data.byteLength, type, arrayBuffer: read, read };
}

const LAB_URL = "https://example.test/anatomy/?mode=atlas&embed=1&lab=organ";

function setup(options: Omit<LabConnectionOptions, "window" | "timers"> = {}) {
  const frame = new FakeFrame();
  const host = new FakeHost();
  const timers = manualTimers();
  const lab = fakeRegistry();
  const document = frame.navigate(LAB_URL, lab.registry);
  const connection = connectLab(frame as unknown as LabFrame, { window: host as unknown as HostWindow, timers, platform: "mac", ...options });
  return { frame, host, timers, lab, document, connection };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

// Pure helpers ------------------------------------------------------------------------------------------------------------

describe("ready message filter", () => {
  const frameWindow = {};
  const message = { type: LAB_READY_MESSAGE, protocol: LAB_SESSION_PROTOCOL, labId: "organ" };
  it("accepts only this frame's window, this origin and the contract's message", () => {
    expect(isLabReadyMessage({ source: frameWindow, origin: "https://example.test", data: message }, frameWindow, "https://example.test")).toBe(true);
    expect(isLabReadyMessage({ source: {}, origin: "https://example.test", data: message }, frameWindow, "https://example.test")).toBe(false);
    expect(isLabReadyMessage({ source: frameWindow, origin: "https://evil.test", data: message }, frameWindow, "https://example.test")).toBe(false);
    expect(isLabReadyMessage({ source: frameWindow, origin: "https://example.test", data: { ...message, type: "other" } }, frameWindow, "https://example.test")).toBe(false);
    expect(isLabReadyMessage({ source: frameWindow, origin: "https://example.test", data: { ...message, protocol: 2 } }, frameWindow, "https://example.test")).toBe(false);
    expect(isLabReadyMessage({ source: frameWindow, origin: "https://example.test", data: "viscera:lab-session" }, frameWindow, "https://example.test")).toBe(false);
    expect(isLabReadyMessage({ source: null, origin: "https://example.test", data: message }, null, "https://example.test")).toBe(false);
  });
});

describe("lab documents into the platform realm", () => {
  it("copies states as checked JSON", () => {
    const state = { b: [1, undefined, { c: "x" }], a: true, skip: undefined, n: null };
    const copy = cloneJson(state, "state");
    expect(copy).toEqual({ b: [1, null, { c: "x" }], a: true, n: null });
    expect(copy).not.toBe(state);
    const crossRealm = Object.assign(Object.create(null) as object, { seed: "18446744073709551615" });
    expect(cloneJson(crossRealm)).toEqual({ seed: "18446744073709551615" });
    expect(() => cloneJson({ x: Number.NaN }, "state")).toThrow(/state\.x is not a finite number/);
    expect(() => cloneJson({ seed: 2 ** 64 }, "state")).toThrow(/state\.seed is an integer beyond 2\^53/);
    expect(() => cloneJson({ sculpt: new Float32Array(3) }, "state")).toThrow(/state\.sculpt is not a plain object/);
    expect(() => cloneJson({ at: new Date(0) }, "state")).toThrow(/not a plain object/);
    expect(() => cloneJson({ run: () => 1 }, "state")).toThrow(/state\.run is a function/);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => cloneJson(cycle, "state")).toThrow(/nested too deeply/);
  });

  it("rebuilds foreign Blobs byte for byte, once per Blob object", async () => {
    const foreign = foreignBlob([1, 2, 3, 250], "model/gltf-binary");
    const cache = new WeakMap<object, Blob>();
    const blob = await toHostBlob(foreign, "attachments.mesh", cache);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("model/gltf-binary");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 250]);
    expect(await toHostBlob(foreign, "attachments.mesh", cache)).toBe(blob);
    expect(foreign.read).toHaveBeenCalledTimes(1);
    const own = new Blob(["x"]);
    expect(await toHostBlob(own)).toBe(own);
    await expect(toHostBlob({ size: 9, type: "", arrayBuffer: async () => new ArrayBuffer(3) }, "attachments.x")).rejects.toThrow(/read 3 bytes of 9/);
    await expect(toHostBlob("not a blob", "thumbnail")).rejects.toBeInstanceOf(LabDocumentError);
  });

  it("checks names, ids and shapes of a serialized document", async () => {
    const sculpt = foreignBlob([9, 9]);
    const document = await normalizeLabDocument({
      schema: "viscera.atlas-session/1",
      labId: "organ",
      state: { spec: { seed: "1" } },
      versions: { generator: "atlas-2.0.0" },
      attachments: { "sculpt.f32": sculpt, ignored: undefined },
    });
    expect(document.state).toEqual({ spec: { seed: "1" } });
    expect(document.versions).toEqual({ generator: "atlas-2.0.0" });
    expect(Object.keys(document.attachments ?? {})).toEqual(["sculpt.f32"]);
    expect(document.attachments?.["sculpt.f32"]).toBeInstanceOf(Blob);
    await expect(normalizeLabDocument({ schema: "s/1", labId: "organ", state: {}, attachments: { "../x": sculpt } })).rejects.toThrow(/attachments\.\.\.\/x is not a valid name/);
    await expect(normalizeLabDocument({ schema: "s/1", labId: "organ", state: {}, attachments: { ".hidden": sculpt } })).rejects.toBeInstanceOf(LabDocumentError);
    const many = Object.fromEntries(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => [`a${i}`, sculpt]));
    await expect(normalizeLabDocument({ schema: "s/1", labId: "organ", state: {}, attachments: many })).rejects.toThrow(/more than 64/);
    await expect(normalizeLabDocument({ schema: "", labId: "organ", state: {} })).rejects.toThrow(/schema/);
    await expect(normalizeLabDocument({ schema: "s/1", labId: "Organ Lab", state: {} })).rejects.toThrow(/labId/);
    await expect(normalizeLabDocument({ schema: "s/1", labId: "organ" })).rejects.toThrow(/state is missing/);
    await expect(normalizeLabDocument({ schema: "s/1", labId: "organ", state: {}, versions: { a: 1 } })).rejects.toThrow(/versions\.a/);
    await expect(normalizeLabDocument(null)).rejects.toThrow(/document is not an object/);
  });

  it("keeps the local-only names of attachments the document carries", async () => {
    const blob = foreignBlob([1]);
    const document = await normalizeLabDocument({
      schema: "s/1",
      labId: "organ",
      state: {},
      attachments: { "pbr.json": blob, "mesh.bin": blob },
      localOnly: ["pbr.json", "pbr.json", "absent.bin"],
    });
    expect(document.localOnly).toEqual(["pbr.json"]);
    const none = await normalizeLabDocument({ schema: "s/1", labId: "organ", state: {}, localOnly: ["absent.bin"] });
    expect(none.localOnly).toBeUndefined();
    await expect(normalizeLabDocument({ schema: "s/1", labId: "organ", state: {}, localOnly: "pbr.json" })).rejects.toThrow(/localOnly must list/);
    await expect(normalizeLabDocument({ schema: "s/1", labId: "organ", state: {}, localOnly: ["../x"] })).rejects.toThrow(/localOnly\[0\]/);
  });

  it("checks library exports and copies claims character for character", async () => {
    const raw = {
      kind: "shape",
      title: "Liver variation",
      tags: ["liver"],
      files: [{ filename: "liver.glb", role: "mesh", blob: foreignBlob([1], "model/gltf-binary") }],
      thumbnail: foreignBlob([2], "image/webp"),
      metadata: { seed: "18446744073709551615" },
      claims: { evidence: "  Vertex colours baked in this browser.  ", limitations: ["Not a clinical model."], rights: "CC BY 4.0" },
    };
    const result = await normalizeLibraryExport(raw);
    expect(result.files[0]?.blob).toBeInstanceOf(Blob);
    expect(result.thumbnail).toBeInstanceOf(Blob);
    expect(result.claims).toEqual(raw.claims);
    expect(result.metadata).toEqual({ seed: "18446744073709551615" });
    await expect(normalizeLibraryExport({ ...raw, files: [{ ...raw.files[0], filename: "../liver.glb" }] })).rejects.toThrow(/filename/);
    await expect(normalizeLibraryExport({ ...raw, files: [{ ...raw.files[0], role: "secret" }] })).rejects.toThrow(/role/);
    await expect(normalizeLibraryExport({ ...raw, files: [raw.files[0], { ...raw.files[0], filename: "LIVER.glb" }] })).rejects.toThrow(/repeats/);
    await expect(normalizeLibraryExport({ ...raw, kind: "video" })).rejects.toThrow(/kind/);
    await expect(normalizeLibraryExport({ ...raw, claims: { evidence: "x" } })).rejects.toThrow(/limitations/);
  });

  it("copies restore reports defensively", () => {
    expect(copyRestoreReport({ exact: true, warnings: ["The simulation restarted from rest.", 3] })).toEqual({
      exact: true,
      warnings: ["The simulation restarted from rest."],
    });
    expect(copyRestoreReport(undefined)).toEqual({ exact: false, warnings: [] });
  });
});

// Connection ------------------------------------------------------------------------------------------------------------

describe("connectLab", () => {
  it("discovers a lab through its ready message and forwards its changes", async () => {
    const frame = new FakeFrame();
    const host = new FakeHost();
    frame.navigate("about:blank", null);
    const connection = connectLab(frame as unknown as LabFrame, { window: host as unknown as HostWindow, timers: manualTimers() });
    expect(connection.adapter()).toBeNull();
    const ready = connection.ready();
    const lab = fakeRegistry();
    frame.navigate(LAB_URL, lab.registry);
    const adapter = fakeAdapter();
    const handle = lab.register(adapter);
    host.post({ type: LAB_READY_MESSAGE, protocol: LAB_SESSION_PROTOCOL, labId: "organ" }, frame.contentWindow);
    expect(await ready).toBe(adapter);
    expect(connection.adapter()).toBe(adapter);
    expect(connection.url()).toBe(LAB_URL);
    const changes: string[] = [];
    connection.onChange((kind) => changes.push(kind));
    handle.changed("document");
    handle.changed("view");
    lab.emit({ type: "change", labId: "other-lab", kind: "document" });
    expect(changes).toEqual(["document", "view"]);
  });

  it("ignores ready messages from other windows and origins", () => {
    const frame = new FakeFrame();
    const host = new FakeHost();
    frame.navigate("about:blank", null);
    const connection = connectLab(frame as unknown as LabFrame, { window: host as unknown as HostWindow, timers: manualTimers() });
    const lab = fakeRegistry();
    frame.navigate(LAB_URL, lab.registry);
    lab.register(fakeAdapter());
    const message = { type: LAB_READY_MESSAGE, protocol: LAB_SESSION_PROTOCOL, labId: "organ" };
    host.post(message, {});
    host.post(message, frame.contentWindow, "https://evil.test");
    expect(connection.adapter()).toBeNull();
    host.post(message, frame.contentWindow);
    expect(connection.adapter()).not.toBeNull();
  });

  it("connects to a lab that registered before the platform listened", async () => {
    const { lab, connection } = setup();
    expect(connection.adapter()).toBeNull();
    const adapter = fakeAdapter();
    lab.register(adapter);
    expect(connection.adapter()).toBe(adapter);
    const early = fakeRegistry();
    early.register(adapter);
    const frame = new FakeFrame();
    frame.navigate(LAB_URL, early.registry);
    const late = connectLab(frame as unknown as LabFrame, { window: new FakeHost() as unknown as HostWindow, timers: manualTimers() });
    expect(await late.ready()).toBe(adapter);
  });

  it("rejects ready() when no lab registers in time, and recovers when one does", async () => {
    const { lab, timers, connection } = setup({ timeoutMs: 5_000 });
    const ready = connection.ready();
    await timers.advance(5_000);
    await expect(ready).rejects.toMatchObject({ name: "TimeoutError" });
    await expect(connection.ready()).rejects.toMatchObject({ name: "TimeoutError" });
    const adapter = fakeAdapter();
    lab.register(adapter);
    expect(await connection.ready()).toBe(adapter);
  });

  it("refuses a registry that speaks another protocol", async () => {
    const frame = new FakeFrame();
    frame.navigate(LAB_URL, fakeRegistry(2).registry);
    const connection = connectLab(frame as unknown as LabFrame, { window: new FakeHost() as unknown as HostWindow, timers: manualTimers() });
    await expect(connection.ready()).rejects.toBeInstanceOf(LabUnavailableError);
  });

  it("follows reloads: drops the old adapter and reconnects to the new document", () => {
    const { frame, lab, document, connection } = setup();
    const first = fakeAdapter();
    const handle = lab.register(first);
    const disposed: string[] = [];
    const adapters: Array<LabSessionAdapter | null> = [];
    connection.onDispose((labId) => disposed.push(labId));
    connection.onAdapter((adapter) => adapters.push(adapter));
    const changes: string[] = [];
    connection.onChange((kind) => changes.push(kind));
    // keydown, pointerdown, click and visibilitychange on the document; pagehide on its window
    expect(document.count()).toBe(4);
    expect(frame.contentWindow.count("pagehide")).toBe(1);
    const next = fakeRegistry();
    const nextDocument = frame.navigate("https://example.test/anatomy/?mode=atlas&embed=1&lab=organ&template=male-liver", next.registry);
    frame.dispatch("load");
    expect(connection.adapter()).toBeNull();
    expect(disposed).toEqual(["organ"]);
    expect(lab.listeners.size).toBe(0);
    expect(document.count()).toBe(0);
    expect(nextDocument.count()).toBe(4);
    expect(frame.contentWindow.count("pagehide")).toBe(1);
    handle.changed("document");
    expect(changes).toEqual([]);
    const second = fakeAdapter();
    next.register(second);
    expect(connection.adapter()).toBe(second);
    expect(adapters).toEqual([null, second]);
  });

  it("stays with its own lab when another lab registers on top (a nested dialog)", () => {
    const { frame, lab, connection: newest } = setup();
    const pinned = connectLab(frame as unknown as LabFrame, { window: new FakeHost() as unknown as HostWindow, timers: manualTimers(), labId: "organ" });
    const organ = fakeAdapter("organ");
    const organHandle = lab.register(organ);
    const physics = fakeAdapter("physics");
    const physicsHandle = lab.register(physics);
    expect(newest.adapter()).toBe(physics);
    expect(pinned.adapter()).toBe(organ);
    const changes: string[] = [];
    const disposed: string[] = [];
    pinned.onChange((kind) => changes.push(kind));
    pinned.onDispose((labId) => disposed.push(labId));
    organHandle.changed("document");
    physicsHandle.changed("view");
    expect(changes).toEqual(["document"]);
    physicsHandle.dispose();
    expect(pinned.adapter()).toBe(organ);
    expect(newest.adapter()).toBe(organ);
    expect(disposed).toEqual([]);
    organHandle.dispose();
    expect(pinned.adapter()).toBeNull();
    expect(disposed).toEqual(["organ"]);
  });

  it("reports a lab that leaves on its own, once, but not the platform's own loads", async () => {
    const frame = new FakeFrame();
    const host = new FakeHost();
    frame.navigate("about:blank", null);
    const onFlush = vi.fn();
    const connection = connectLab(frame as unknown as LabFrame, { window: host as unknown as HostWindow, timers: manualTimers(), onFlush });
    const left: Array<{ reason: string; url: string | null }> = [];
    connection.onLeave((event) => left.push(event));
    // the lab's first load replaces the initial about:blank document: expected
    const first = fakeRegistry();
    frame.navigate(LAB_URL, first.registry);
    frame.dispatch("load");
    first.register(fakeAdapter());
    expect(left).toEqual([]);
    expect(connection.canRestore()).toBe(true);
    // the platform reloads it: pagehide flushes, nothing has left
    const reloading = connection.reload("lab.html?mode=atlas&embed=1&lab=organ&restore=pending");
    expect(frame.src).toBe("lab.html?mode=atlas&embed=1&lab=organ&restore=pending");
    frame.contentWindow.dispatch("pagehide", { persisted: false });
    const second = fakeRegistry();
    frame.navigate(`${LAB_URL}&restore=pending`, second.registry);
    frame.dispatch("load");
    const secondAdapter = fakeAdapter();
    second.register(secondAdapter);
    expect(await reloading).toBe(secondAdapter);
    expect(onFlush).toHaveBeenCalledWith("pagehide");
    expect(left).toEqual([]);
    // the lab unloads by itself: one leave, even though a new document follows
    frame.contentWindow.dispatch("pagehide", { persisted: false });
    frame.navigate("https://example.test/anatomy/?mode=imports", null);
    frame.dispatch("load");
    expect(left).toEqual([{ reason: "unloaded", url: `${LAB_URL}&restore=pending` }]);
    // a document that simply replaces the lab (no pagehide seen) counts too; a page kept in the bfcache does not
    frame.contentWindow.dispatch("pagehide", { persisted: true });
    frame.navigate("https://example.test/anatomy/?mode=legacy", null);
    frame.dispatch("load");
    expect(left.map((event) => event.reason)).toEqual(["unloaded", "navigated"]);
  });

  it("rejects reload() when the new document never registers", async () => {
    const { frame, timers, connection } = setup({ timeoutMs: 2_000 });
    const reloading = connection.reload();
    expect(frame.src).toBe(LAB_URL);
    await timers.advance(2_000);
    await expect(reloading).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("cancels navigations the lab starts by script and hands them to the platform", () => {
    const frame = new FakeFrame();
    frame.contentWindow.navigation = new FakeTarget();
    const lab = fakeRegistry();
    frame.navigate(LAB_URL, lab.registry);
    const onNavigate = vi.fn();
    const connection = connectLab(frame as unknown as LabFrame, { window: new FakeHost() as unknown as HostWindow, timers: manualTimers(), onNavigate });
    lab.register(fakeAdapter());
    const navigation = frame.contentWindow.navigation;
    const navigate = (init: Record<string, unknown>) => {
      const event = { cancelable: true, hashChange: false, downloadRequest: null, preventDefault: vi.fn(), ...init };
      navigation.dispatch("navigate", event);
      return event;
    };
    const away = navigate({ destination: { url: "https://example.test/anatomy/?mode=imports", sameDocument: false } });
    expect(away.preventDefault).toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith({ url: "https://example.test/anatomy/?mode=imports", reason: "page", labId: null });
    // replaceState workspace switches, hash changes, downloads and uncancelable traversals pass
    expect(navigate({ destination: { url: `${LAB_URL}&workspace=scene`, sameDocument: true } }).preventDefault).not.toHaveBeenCalled();
    expect(navigate({ hashChange: true, destination: { url: `${LAB_URL}#x`, sameDocument: true } }).preventDefault).not.toHaveBeenCalled();
    expect(navigate({ downloadRequest: "liver.glb", destination: { url: "https://example.test/x.glb", sameDocument: false } }).preventDefault).not.toHaveBeenCalled();
    expect(navigate({ cancelable: false, destination: { url: "https://example.test/anatomy/?mode=fat", sameDocument: false } }).preventDefault).not.toHaveBeenCalled();
    // the platform's own reload passes too
    void connection.reload().catch(() => undefined);
    expect(navigate({ destination: { url: LAB_URL, sameDocument: false } }).preventDefault).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledTimes(1);
    connection.dispose();
    expect(navigation.count()).toBe(0);
  });

  it("restarts a restore on the next registration when the lab disposes its session meanwhile", async () => {
    const { lab, connection } = setup();
    const signals: AbortSignal[] = [];
    const first = lab.register(
      fakeAdapter("organ", {
        restore: (_document, signal) => {
          signals.push(signal);
          return new Promise(() => undefined);
        },
      }),
    );
    const restoring = connection.restore({ schema: "viscera.test/1", labId: "organ", state: { value: 4 } });
    await flush();
    expect(signals).toHaveLength(1);
    // React StrictMode in development: unmount (dispose) and mount (register) again
    first.dispose();
    expect(signals[0]?.aborted).toBe(true);
    const second = fakeAdapter();
    lab.register(second);
    expect(await restoring).toEqual({ exact: true, warnings: [] });
    expect(second.restored[0]?.state).toEqual({ value: 4 });
    expect(connection.canRestore()).toBe(false);
  });

  it("restores only a fresh lab: no change reported and no input since it loaded", async () => {
    const { frame, lab, document, connection } = setup();
    const handle = lab.register(fakeAdapter());
    expect(connection.canRestore()).toBe(true);
    document.dispatch("pointerdown", {});
    expect(connection.canRestore()).toBe(false);
    await expect(connection.restore({ schema: "viscera.test/1", labId: "organ", state: {} })).rejects.toThrow(/used since it loaded/);
    // a reload makes it fresh again; a change the lab reports spends it
    const next = fakeRegistry();
    frame.navigate(LAB_URL, next.registry);
    frame.dispatch("load");
    next.register(fakeAdapter());
    expect(connection.canRestore()).toBe(true);
    next.emit({ type: "change", labId: "organ", kind: "view" });
    expect(connection.canRestore()).toBe(false);
    handle.changed();
  });

  it("waits for the lab to register before restoring", async () => {
    const { lab, connection } = setup();
    const restoring = connection.restore({ schema: "viscera.test/1", labId: "organ", state: { value: 2 } });
    const adapter = fakeAdapter();
    lab.register(adapter);
    expect(await restoring).toEqual({ exact: true, warnings: [] });
    expect(adapter.restored).toHaveLength(1);
  });

  it("reports when the lab disposes its session", () => {
    const { lab, connection } = setup();
    const handle = lab.register(fakeAdapter());
    const disposed: string[] = [];
    connection.onDispose((labId) => disposed.push(labId));
    handle.dispose();
    expect(connection.adapter()).toBeNull();
    expect(disposed).toEqual(["organ"]);
  });

  it("serializes only an idle lab and copies the result into the platform realm", async () => {
    const { lab, connection } = setup();
    await expect(connection.serialize()).rejects.toBeInstanceOf(LabUnavailableError);
    const sculpt = foreignBlob([1, 2, 3]);
    const state = { spec: { width: 1.2 } };
    const adapter = fakeAdapter("organ", {
      serialize: async () => ({ schema: "viscera.atlas-session/1", labId: "organ", state, attachments: { "sculpt.f32": sculpt } }) as unknown as LabSessionDocument,
    });
    lab.register(adapter);
    const document = await connection.serialize();
    expect(document.state).toEqual(state);
    expect(document.state).not.toBe(state);
    expect(document.attachments?.["sculpt.f32"]).toBeInstanceOf(Blob);
    (adapter as TestAdapter).busyReason = "baking";
    await expect(connection.serialize()).rejects.toMatchObject({ name: "LabBusyError", reason: "baking" });
    (adapter as TestAdapter).busyReason = false;
    const other = fakeAdapter("organ", { serialize: () => ({ schema: "s/1", labId: "scene", state: {} }) });
    lab.register(other);
    await expect(connection.serialize()).rejects.toThrow(/registered lab is "organ"/);
  });

  it("is busy for the adapter, an active scene recording and platform holds", () => {
    const { lab, document, connection } = setup();
    expect(connection.busy()).toBe("loading");
    const adapter = fakeAdapter();
    lab.register(adapter);
    expect(connection.busy()).toBe(false);
    adapter.busyReason = "running";
    expect(connection.busy()).toBe("running");
    adapter.busyReason = false;
    document.recording = true;
    expect(connection.busy()).toBe("recording");
    document.recording = false;
    const release = connection.hold("capturing");
    expect(connection.busy()).toBe("capturing");
    release();
    release();
    expect(connection.busy()).toBe(false);
    lab.register(fakeAdapter("organ", { busy: () => { throw new Error("lab bug"); } }));
    expect(connection.busy()).toBe("unavailable");
  });

  it("restores once per load into the lab's realm, waiting for it to be idle", async () => {
    const { frame, lab, timers, connection } = setup();
    const cloned: unknown[] = [];
    frame.contentWindow.structuredClone = <T,>(value: T): T => {
      cloned.push(value);
      return JSON.parse(JSON.stringify(value)) as T;
    };
    const adapter = fakeAdapter();
    adapter.busyReason = "loading";
    lab.register(adapter);
    const document: LabSessionDocument = { schema: "viscera.test/1", labId: "organ", state: { value: 7 } };
    const restoring = connection.restore(document);
    await timers.advance(300);
    expect(adapter.restored).toHaveLength(0);
    adapter.busyReason = false;
    await timers.advance(100);
    expect(await restoring).toEqual({ exact: true, warnings: [] });
    // the document and the restore context both go into the lab's realm
    expect(cloned).toEqual([document, { missingLocal: [] }]);
    expect(adapter.restored[0]).toEqual(document);
    expect(adapter.restored[0]).not.toBe(document);
    await expect(connection.restore(document)).rejects.toThrow(/already received a document/);
    await expect(
      (async () => {
        const reload = fakeRegistry();
        frame.navigate(LAB_URL, reload.registry);
        frame.dispatch("load");
        reload.register(fakeAdapter("scene"));
        return connection.restore(document);
      })(),
    ).rejects.toBeInstanceOf(LabDocumentError);
  });

  it("gives up a restore at its timeout or when aborted", async () => {
    const { frame, lab, timers, connection } = setup({ restoreTimeoutMs: 1_000 });
    lab.register(fakeAdapter("organ", { restore: () => new Promise(() => undefined) }));
    const document: LabSessionDocument = { schema: "viscera.test/1", labId: "organ", state: {} };
    const restoring = connection.restore(document);
    await timers.advance(1_000);
    await expect(restoring).rejects.toMatchObject({ name: "TimeoutError" });
    const reload = fakeRegistry();
    frame.navigate(LAB_URL, reload.registry);
    frame.dispatch("load");
    reload.register(fakeAdapter("organ", { restore: () => new Promise(() => undefined) }));
    const controller = new AbortController();
    const aborted = connection.restore(document, { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
  });

  it("takes ⌘S and ⇧⌘S from the lab before the browser or the lab sees them", () => {
    const onSave = vi.fn();
    const onSaveNamed = vi.fn();
    const palette = vi.fn();
    const { document } = setup({ onSave, onSaveNamed, shortcuts: { "command-palette": palette } });
    expect(document.captures("keydown")).toBe(true);
    const press = (init: Record<string, unknown>) => {
      const event = { key: "s", code: "KeyS", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...init };
      document.dispatch("keydown", event);
      return event;
    };
    const save = press({});
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(save.preventDefault).toHaveBeenCalled();
    expect(save.stopPropagation).toHaveBeenCalled();
    const held = press({ repeat: true });
    expect(held.preventDefault).toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
    press({ key: "S", shiftKey: true });
    expect(onSaveNamed).toHaveBeenCalledTimes(1);
    press({ key: "k", code: "KeyK" });
    expect(palette).toHaveBeenCalledTimes(1);
    // no handler for Version History: the key is left alone
    const history = press({ key: "¥", code: "KeyY", altKey: true });
    expect(history.preventDefault).not.toHaveBeenCalled();
    const lab = press({ key: "z", code: "KeyZ" });
    expect(lab.preventDefault).not.toHaveBeenCalled();
  });

  it("hands links that would leave the lab to the platform", () => {
    const onNavigate = vi.fn();
    const { document } = setup({ onNavigate });
    expect(document.captures("click")).toBe(true);
    const click = (attributes: Record<string, string>, init: Record<string, unknown> = {}) => {
      const anchor = {
        getAttribute: (name: string) => attributes[name] ?? null,
        hasAttribute: (name: string) => name in attributes,
      };
      const event = {
        target: { closest: (selector: string) => (selector.includes("a[href]") ? anchor : null) },
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false,
        preventDefault: vi.fn(),
        ...init,
      };
      document.dispatch("click", event);
      return event;
    };
    const away = click({ href: "?mode=textures" });
    expect(away.preventDefault).toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledWith({ url: "https://example.test/anatomy/?mode=textures", reason: "lab", labId: "texture-lab" });
    const inPage = click({ href: "#atlas-disease-panel" });
    expect(inPage.preventDefault).not.toHaveBeenCalled();
    const newTab = click({ href: "https://doi.org/x", target: "_blank" });
    expect(newTab.preventDefault).not.toHaveBeenCalled();
    const notALink = { target: { closest: () => null }, preventDefault: vi.fn(), button: 0 };
    document.dispatch("click", notALink);
    expect(notALink.preventDefault).not.toHaveBeenCalled();
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("leaves links alone without a navigation handler", () => {
    const { document } = setup();
    const event = {
      target: { closest: () => ({ getAttribute: (name: string) => (name === "href" ? "?mode=textures" : null), hasAttribute: () => false }) },
      button: 0,
      preventDefault: vi.fn(),
    };
    document.dispatch("click", event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("asks the platform to flush when the lab is hidden or unloads", () => {
    const onFlush = vi.fn();
    const { frame, document } = setup({ onFlush });
    document.dispatch("visibilitychange");
    expect(onFlush).not.toHaveBeenCalled();
    document.visibilityState = "hidden";
    document.dispatch("visibilitychange");
    frame.contentWindow.dispatch("pagehide");
    // the unloading document turning hidden afterwards is not a second flush
    document.dispatch("visibilitychange");
    expect(onFlush.mock.calls).toEqual([["hidden"], ["pagehide"]]);
  });

  it("thumbnails through the adapter (copied into the platform realm), never while busy", async () => {
    const { lab, connection } = setup();
    const still = foreignBlob([1, 2], "image/webp");
    const thumbnail = vi.fn(async () => still as unknown as Blob);
    const adapter = fakeAdapter("organ", { thumbnail });
    lab.register(adapter);
    const blob = await connection.thumbnail(640, 400);
    expect(blob).toBeInstanceOf(Blob);
    expect(thumbnail).toHaveBeenCalledWith(640, 400);
    adapter.busyReason = "recording";
    expect(await connection.thumbnail(640, 400)).toBeNull();
    expect(thumbnail).toHaveBeenCalledTimes(1);
    adapter.busyReason = false;
    thumbnail.mockRejectedValueOnce(new Error("context lost"));
    expect(await connection.thumbnail(640, 400)).toBeNull();
    lab.register(fakeAdapter());
    // no adapter thumbnail and no visible canvas: nothing to show
    expect(await connection.thumbnail(640, 400)).toBeNull();
  });

  it("runs lab exports holding the lab busy and returns them normalised", async () => {
    const { lab, connection } = setup();
    let busyDuringRun: false | string = false;
    const action: LabExportAction = {
      id: "shape",
      label: "Add shape to Library",
      kind: "shape",
      run: async () => {
        busyDuringRun = connection.busy();
        return {
          kind: "shape",
          title: "Liver",
          files: [{ filename: "liver.glb", role: "mesh", blob: foreignBlob([1], "model/gltf-binary") as unknown as Blob }],
          claims: { evidence: "Baked in the browser.", limitations: [] },
        };
      },
    };
    lab.register(fakeAdapter("organ", { exports: () => [action] }));
    expect(connection.exportActions()).toEqual([{ id: "shape", label: "Add shape to Library", kind: "shape" }]);
    const result = await connection.runExport("shape");
    expect(busyDuringRun).toBe("exporting");
    expect(connection.busy()).toBe(false);
    expect(result.files[0]?.blob).toBeInstanceOf(Blob);
    await expect(connection.runExport("missing")).rejects.toBeInstanceOf(LabUnavailableError);
  });

  it("refuses research-only exports for the Library", async () => {
    const { lab, connection } = setup();
    const researchOnly: LabExportAction = {
      id: "material",
      label: "Add material to Library",
      kind: "material",
      run: async () => ({
        kind: "material",
        title: "DSAD-derived study",
        files: [{ filename: "study.json", role: "data", blob: new Blob(["{}"], { type: "application/json" }) }],
        claims: { evidence: "Generated by the LoRA study.", limitations: [], rights: "Research-only until the licence is resolved." },
      }),
    };
    lab.register(fakeAdapter("organ", { exports: () => [researchOnly] }));
    await expect(connection.runExport("material")).rejects.toMatchObject({ name: "LabRightsError" });
    expect(connection.busy()).toBe(false);
    expect(isResearchOnly({ rights: "CC BY 4.0" })).toBe(false);
    expect(isResearchOnly({ rights: "research use only" })).toBe(true);
    expect(isResearchOnly({})).toBe(false);
  });

  it("removes every listener on dispose and rejects waiting callers", async () => {
    const { frame, host, lab, document, connection } = setup();
    const ready = connection.ready();
    connection.dispose();
    await expect(ready).rejects.toBeInstanceOf(LabUnavailableError);
    expect(host.count()).toBe(0);
    expect(frame.count()).toBe(0);
    expect(document.count()).toBe(0);
    expect(frame.contentWindow.count()).toBe(0);
    expect(lab.listeners.size).toBe(0);
    connection.dispose();
    lab.register(fakeAdapter());
    expect(connection.adapter()).toBeNull();
    await expect(connection.ready()).rejects.toBeInstanceOf(LabUnavailableError);
  });

  it("lets two connections share a frame (React StrictMode mounts twice)", async () => {
    const frame = new FakeFrame();
    const host = new FakeHost();
    const lab = fakeRegistry();
    frame.navigate(LAB_URL, lab.registry);
    const first = connectLab(frame as unknown as LabFrame, { window: host as unknown as HostWindow, timers: manualTimers() });
    const second = connectLab(frame as unknown as LabFrame, { window: host as unknown as HostWindow, timers: manualTimers() });
    first.dispose();
    const handle = lab.register(fakeAdapter());
    const changes: string[] = [];
    second.onChange((kind) => changes.push(kind));
    handle.changed();
    expect(changes).toEqual(["document"]);
    expect(first.adapter()).toBeNull();
    await flush();
  });

  it("describes the registered lab", () => {
    const { lab, connection } = setup();
    expect(connection.info()).toBeNull();
    lab.register(fakeAdapter("organ", { title: "Organ Design" }));
    expect(connection.info()).toEqual({ labId: "organ", title: "Organ Design" });
  });

  it("hands missing local-only attachments to the lab's restore context", async () => {
    const { lab, connection } = setup();
    const contexts: unknown[] = [];
    lab.register(
      fakeAdapter("organ", {
        restore: async (_document, _signal, context) => {
          contexts.push(context);
          return { exact: false, warnings: ["The PBR file is not on this device."] };
        },
      }),
    );
    const report = await connection.restore(
      { schema: "viscera.test/1", labId: "organ", state: {} },
      { missingLocal: [{ name: "pbr.json", sha256: "a".repeat(64) }] },
    );
    expect(contexts).toEqual([{ missingLocal: [{ name: "pbr.json", sha256: "a".repeat(64) }] }]);
    expect(report).toEqual({ exact: false, warnings: ["The PBR file is not on this device."] });
  });

  it("refuses another lab's document on a connection pinned to its project's lab", async () => {
    const { frame, lab } = setup();
    const pinned = connectLab(frame as unknown as LabFrame, { window: new FakeHost() as unknown as HostWindow, timers: manualTimers(), labId: "organ" });
    const adapter = fakeAdapter("organ");
    lab.register(adapter);
    await expect(pinned.restore({ schema: "viscera.test/1", labId: "texture-lab", state: {} })).rejects.toThrow(/this connection serves "organ"/);
    expect(adapter.restored).toHaveLength(0);
    // the refusal did not spend the fresh lab
    expect(pinned.canRestore()).toBe(true);
  });

  it("starts a lab that waits with ?restore=pending, once per load, also after a failed restore", async () => {
    const frame = new FakeFrame();
    const host = new FakeHost();
    const timers = manualTimers();
    let lab = fakeRegistry();
    frame.navigate(`${LAB_URL}&restore=pending`, lab.registry);
    const connection = connectLab(frame as unknown as LabFrame, { window: host as unknown as HostWindow, timers, platform: "mac" });
    const started: string[] = [];
    const adapterWithStart = (name: string, restore?: LabSessionAdapter["restore"]) =>
      fakeAdapter("organ", { startFresh: () => started.push(name), ...(restore ? { restore } : {}) });
    // waits for the lab to register
    const starting = connection.startFresh();
    lab.register(adapterWithStart("first"));
    expect(await starting).toBe(true);
    expect(started).toEqual(["first"]);
    expect(await connection.startFresh()).toBe(false);
    expect(connection.canRestore()).toBe(false);
    await expect(connection.restore({ schema: "viscera.test/1", labId: "organ", state: {} })).rejects.toThrow(/started fresh/);
    // a restore that fails leaves the waiting lab startable
    lab = fakeRegistry();
    frame.navigate(`${LAB_URL}&restore=pending`, lab.registry);
    frame.dispatch("load");
    lab.register(adapterWithStart("second", async () => {
      throw new Error("The template is missing.");
    }));
    await expect(connection.restore({ schema: "viscera.test/1", labId: "organ", state: {} })).rejects.toThrow(/template is missing/);
    expect(await connection.startFresh()).toBe(true);
    expect(started).toEqual(["first", "second"]);
    // a lab that did not wait already ran its own start-up
    lab = fakeRegistry();
    frame.navigate(LAB_URL, lab.registry);
    frame.dispatch("load");
    lab.register(adapterWithStart("third"));
    expect(await connection.startFresh()).toBe(false);
    expect(started).toEqual(["first", "second"]);
  });

  it("offers the lab's exports as runnable actions, refusing research-only results", async () => {
    const { lab, connection } = setup();
    const make = (rights?: string): LabExportAction => ({
      id: rights ? "study" : "shape",
      label: rights ? "Add study to Library" : "Add shape to Library",
      kind: "shape",
      run: async () => ({
        kind: "shape",
        title: "Liver",
        files: [{ filename: "liver.glb", role: "mesh", blob: new Blob([new Uint8Array([1])], { type: "model/gltf-binary" }) }],
        claims: rights ? { evidence: "x", limitations: [], rights } : { evidence: "Baked in the browser.", limitations: ["Not a clinical model."] },
      }),
    });
    lab.register(fakeAdapter("organ", { exports: () => [make(), make("research-only")] }));
    const actions = connection.exports();
    expect(actions.map(({ id, label, kind }) => ({ id, label, kind }))).toEqual([
      { id: "shape", label: "Add shape to Library", kind: "shape" },
      { id: "study", label: "Add study to Library", kind: "shape" },
    ]);
    const shape = await actions[0]!.run();
    expect(shape.claims).toEqual({ evidence: "Baked in the browser.", limitations: ["Not a clinical model."] });
    await expect(actions[1]!.run()).rejects.toMatchObject({ name: "LabRightsError" });
  });

  it("labReloader restores a fresh lab directly, reloads a used one first, and starts a lab whose restore failed", async () => {
    const { frame, lab, connection } = setup();
    let current = fakeAdapter();
    lab.register(current);
    const reload = labReloader(connection, { url: () => `${LAB_URL}&restore=pending` });
    const document: LabSessionDocument = { schema: "viscera.test/1", labId: "organ", state: { value: 3 } };
    const missingLocal = [{ name: "pbr.json", sha256: "b".repeat(64) }];
    expect(await reload({ document, signal: new AbortController().signal, missingLocal })).toEqual({ exact: true, warnings: [] });
    expect(current.restored).toHaveLength(1);
    expect(frame.src).toBe("");
    // the lab is no longer fresh: the next document needs a new load first
    const second = reload({ document, signal: new AbortController().signal });
    expect(frame.src).toBe(`${LAB_URL}&restore=pending`);
    const next = fakeRegistry();
    frame.navigate(`${LAB_URL}&restore=pending`, next.registry);
    frame.dispatch("load");
    current = fakeAdapter();
    next.register(current);
    expect(await second).toEqual({ exact: true, warnings: [] });
    expect(current.restored[0]?.state).toEqual({ value: 3 });
    // a failing restore: the waiting lab is started instead of being left blank
    const third = reload({ document, signal: new AbortController().signal });
    const failing = fakeRegistry();
    frame.navigate(`${LAB_URL}&restore=pending`, failing.registry);
    frame.dispatch("load");
    const started = vi.fn();
    failing.register(fakeAdapter("organ", { startFresh: started, restore: async () => {
      throw new Error("The sculpt could not be applied.");
    } }));
    await expect(third).rejects.toThrow(/sculpt could not be applied/);
    await flush();
    expect(started).toHaveBeenCalledTimes(1);
  });

  it("accepts real DOM objects (compile-time check)", () => {
    const asFrame = (frame: HTMLIFrameElement): LabFrame => frame;
    const asHost = (window: Window): HostWindow => window;
    expect([typeof asFrame, typeof asHost]).toEqual(["function", "function"]);
  });
});
