import { describe, expect, it, vi } from "vitest";
import { PerspectiveCamera, Vector2, type WebGLRenderer } from "three";
import { getSceneRecordingSource, registerSceneRecordingSource, registerNativeSceneRecordingSource } from "./sceneRecording";

function fixture(available = () => true) {
  const canvas = Object.assign(new EventTarget(), { width: 1600, height: 1200, isConnected: true, style: { position: "", left: "", top: "", width: "800px", height: "600px" }, dataset: {} as Record<string, string> }) as unknown as HTMLCanvasElement;
  const host = { clientWidth: 800, clientHeight: 600 };
  let ratio = 2, width = 800, height = 600;
  const allocations: number[] = [];
  const allocate = () => { canvas.width = width * ratio; canvas.height = height * ratio; allocations.push(canvas.width * canvas.height); };
  const gl = { MAX_VIEWPORT_DIMS: 1, MAX_RENDERBUFFER_SIZE: 2, isContextLost: () => false, getParameter: (key: number): number[] | number => key === 1 ? [8192, 8192] : 8192 };
  const renderer = {
    domElement: canvas, capabilities: { maxTextureSize: 8192 }, getContext: () => gl,
    getSize: (v: Vector2) => v.set(width, height), getPixelRatio: () => ratio,
    // Three.setPixelRatio immediately reallocates using its current logical size.
    setPixelRatio: vi.fn((value: number) => { ratio = value; allocate(); }),
    setSize: vi.fn((w: number, h: number, updateStyle = true) => { width = w; height = h; allocate(); if (updateStyle) { canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; } }),
  };
  const camera = new PerspectiveCamera(48, 4 / 3, .1, 5000); camera.position.set(1, 2, 3); camera.lookAt(4, 5, 6);
  const draw = vi.fn();
  const registration = registerSceneRecordingSource({ renderer: renderer as unknown as WebGLRenderer, camera, host: host as HTMLElement, label: "Test scene", draw, available });
  const prepare = (width = 3840, height = 2160, signal = new AbortController().signal) => registration.source.prepare({ width, height, fps: 30, signal });
  return { canvas, host, renderer, camera, gl, draw, registration, prepare, allocations };
}

describe("native scene recording lease", () => {
  it("shares native WebGPU leases with the recorder without a second rendering device", () => {
    const canvas = { dataset: {} } as HTMLCanvasElement, restore = vi.fn(), prepare = vi.fn(() => ({ restore }));
    const source = { kind: "scene" as const, canvas, label: "GPU fluid", prepare };
    const unregister = registerNativeSceneRecordingSource(source);
    expect(getSceneRecordingSource(canvas)).toBe(source);
    expect(canvas.dataset.sceneRecordingSource).toBe("native");
    const request = { width: 3840, height: 2160, fps: 30, signal: new AbortController().signal };
    getSceneRecordingSource(canvas)!.prepare(request).restore();
    expect(prepare).toHaveBeenCalledWith(request); expect(restore).toHaveBeenCalledOnce();
    expect(() => registerNativeSceneRecordingSource(source)).toThrow(/already/);
    unregister(); unregister(); expect(getSceneRecordingSource(canvas)).toBeUndefined();
    expect(canvas.dataset.sceneRecordingSource).toBeUndefined();
    const next = registerNativeSceneRecordingSource(source); unregister();
    expect(getSceneRecordingSource(canvas)).toBe(source); next();
  });
  it("renders exact requested pixels, preserves pose, and restores current host size and original DPR once", () => {
    const f = fixture(), position = f.camera.position.clone(), quaternion = f.camera.quaternion.clone();
    expect(getSceneRecordingSource(f.canvas)).toBe(f.registration.source);
    const lease = f.prepare();
    expect([f.canvas.width, f.canvas.height]).toEqual([3840, 2160]);
    expect(f.camera.aspect).toBe(16 / 9); expect(f.registration.active).toBe(true);
    expect([f.canvas.style.width, f.canvas.style.height, f.canvas.style.left, f.canvas.style.top]).toEqual(["800px", "450px", "0px", "75px"]);
    expect(f.canvas.dataset.sceneRecordingActive).toBe("true");
    expect(f.camera.position.equals(position)).toBe(true); expect(f.camera.quaternion.equals(quaternion)).toBe(true);
    f.host.clientWidth = 390; f.host.clientHeight = 700;
    lease.restore(); lease.restore();
    expect([f.canvas.width, f.canvas.height]).toEqual([780, 1400]);
    expect(f.camera.aspect).toBe(390 / 700); expect(f.renderer.getPixelRatio()).toBe(2);
    expect([f.canvas.style.width, f.canvas.style.height, f.canvas.style.position]).toEqual(["390px", "700px", ""]);
    expect(f.draw).toHaveBeenCalledTimes(2); expect(f.registration.active).toBe(false);
    expect(f.canvas.dataset.sceneRecordingActive).toBeUndefined();
    expect(f.camera.position.equals(position)).toBe(true); expect(f.camera.quaternion.equals(quaternion)).toBe(true);
    f.registration.dispose();
  });
  it("rejects overlapping leases and permits a new lease only after restoration", () => {
    const f = fixture(), first = f.prepare();
    expect(() => f.prepare()).toThrow(/another capture/);
    first.restore(); f.prepare(1280, 720).restore(); f.registration.dispose();
  });
  it("updates the actual CSS hit rectangle on host resize without changing the native drawing buffer", () => {
    let update = () => {}; const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { update = callback; } observe() {} disconnect = disconnect; });
    try {
      const f = fixture(), lease = f.prepare();
      f.host.clientWidth = 390; f.host.clientHeight = 700; update();
      expect([f.canvas.width, f.canvas.height]).toEqual([3840, 2160]);
      expect(parseFloat(f.canvas.style.width) / parseFloat(f.canvas.style.height)).toBeCloseTo(16 / 9, 8);
      expect(parseFloat(f.canvas.style.left)).toBe(0);
      expect(parseFloat(f.canvas.style.top) * 2 + parseFloat(f.canvas.style.height)).toBe(700);
      lease.restore(); expect(disconnect).toHaveBeenCalledOnce(); f.registration.dispose();
    } finally { vi.unstubAllGlobals(); }
  });
  it("restores high-DPR displays without transiently allocating a DPR-scaled 4K buffer", () => {
    const f = fixture(), lease = f.prepare();
    lease.restore();
    expect(Math.max(...f.allocations)).toBeLessThanOrEqual(3840 * 2160);
    expect([f.canvas.width, f.canvas.height]).toEqual([1600, 1200]);
    f.registration.dispose();
  });
  it.each([[0, 720], [1280.5, 720], [9000, 720], [8192, 8192]])("rejects invalid %i×%i before touching renderer state", (w, h) => {
    const f = fixture();
    expect(() => f.prepare(w, h)).toThrow(/Invalid/);
    expect(f.renderer.setSize).not.toHaveBeenCalled(); expect(f.registration.active).toBe(false); f.registration.dispose();
  });
  it("rejects aborted, detached, unavailable and lost-context sources without changing dimensions", () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    expect(() => f.prepare(1280, 720, controller.signal)).toThrow(/cancelled/);
    Object.defineProperty(f.canvas, "isConnected", { value: false, configurable: true });
    expect(() => f.prepare()).toThrow(/not ready/);
    Object.defineProperty(f.canvas, "isConnected", { value: true });
    f.gl.isContextLost = () => true; expect(() => f.prepare()).toThrow(/GPU/);
    expect(f.renderer.setSize).not.toHaveBeenCalled(); f.registration.dispose();
    const unavailable = fixture(() => false); expect(() => unavailable.prepare()).toThrow(/not ready/); unavailable.registration.dispose();
  });
  it("checks GPU renderbuffer and viewport limits, not just texture dimensions", () => {
    const f = fixture();
    f.gl.getParameter = key => key === 1 ? [8192, 2048] : 8192;
    expect(() => f.prepare()).toThrow(/GPU/);
    f.gl.getParameter = key => key === 1 ? [8192, 8192] : 2048;
    expect(() => f.prepare()).toThrow(/GPU/);
    expect(f.renderer.setSize).not.toHaveBeenCalled(); f.registration.dispose();
  });
  it("restores sizing after failed first draw and releases the lock for retry", () => {
    const f = fixture(); f.draw.mockImplementationOnce(() => { throw new Error("render failed"); });
    expect(() => f.prepare()).toThrow("render failed");
    expect([f.canvas.width, f.canvas.height]).toEqual([1600, 1200]);
    expect(f.registration.active).toBe(false); f.prepare().restore(); f.registration.dispose();
  });
  it.each(["dispose", "webglcontextlost"])("removes source on %s without touching a destroyed renderer on later lease restoration", action => {
    const f = fixture(), lease = f.prepare();
    if (action === "dispose") f.registration.dispose(); else f.canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(getSceneRecordingSource(f.canvas)).toBeUndefined(); expect(f.registration.active).toBe(false);
    f.renderer.setSize.mockClear(); f.draw.mockClear(); lease.restore(); f.registration.dispose();
    expect(f.renderer.setSize).not.toHaveBeenCalled(); expect(f.draw).not.toHaveBeenCalled();
    expect(() => f.prepare()).toThrow(/not ready/);
  });
});
