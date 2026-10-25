import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { AutomaticGrasp } from "./automaticGrasp";
import saved from "./graspDefaultPolicy.json";
function harness() {
  const feedback = { displacement_mm: 1, displacement_gradient_bound: .1, finite: true, tool: { active: true, forceN: [.1, 0, 0], displacementMm: [1, 0, 0], actualSurfacePointMm: [1, 0, 0], residualMm: .1, clamped: false } };
  const tools = { enabled: true, release: vi.fn(), commandAutomaticGrasp: vi.fn(), previewAutomaticGrasp: vi.fn(), attachAutomaticGrasp: vi.fn() };
  const camera = new THREE.PerspectiveCamera(), publish = vi.fn();
  const controller = new AutomaticGrasp({ tools, camera, physics: () => ({ snapshot: () => feedback }), trainingInput: vi.fn(), publish } as unknown as ConstructorParameters<typeof AutomaticGrasp>[0]);
  const state = { ...controller.snapshot(), phase: "holding", plan: { startOffsetMm: 32 }, policy: { action: 0 } };
  Reflect.set(controller, "state", state); Reflect.set(controller, "cameraRotation", camera.quaternion.clone());
  return { feedback, tools, camera, controller, publish };
}
describe("automatic instrument execution guards", () => {
  it("reuses only exact solver inputs and cancels a pending fresh check", async () => {
    const workers: { onmessage?: (event: { data: unknown }) => void; terminate: ReturnType<typeof vi.fn> }[] = [];
    class FakeWorker {
      onmessage?: (event: { data: unknown }) => void;
      terminate = vi.fn(); postMessage = vi.fn();
      constructor() { workers.push(this); }
    }
    vi.stubGlobal("Worker", FakeWorker);
    try {
      const h = harness(); h.feedback.displacement_mm = 0;
      Reflect.set(h.controller, "state", { ...h.controller.snapshot(), phase: "idle" });
      const input = structuredClone(saved.trainingInput);
      Reflect.get(h.controller, "c").trainingInput = () => structuredClone(input);
      Reflect.set(h.tools, "planAutomaticGrasp", async () => ({ startOffsetMm: 12, contact: input.contact, triangleIndex: 0 }));
      const run = () => h.controller.start(new AbortController().signal).catch(error => error as Error);
      const first = run(); await vi.waitFor(() => expect(workers).toHaveLength(1));
      workers[0]!.onmessage!({ data: { type: "complete", policy: structuredClone(saved.policy) } });
      await vi.waitFor(() => expect(h.controller.snapshot().policyStatus).toBe("ready"));
      h.controller.stop(); expect(await first).toBeInstanceOf(Error);
      const cached = run(); await vi.waitFor(() => expect(h.controller.snapshot().timing.source).toBe("cache"));
      expect(workers).toHaveLength(1); h.controller.stop(); await cached;
      input.materials.materials[0]!.young_pa += 100;
      const changed = run(); await vi.waitFor(() => expect(workers).toHaveLength(2));
      expect(h.controller.snapshot().policyStatus).toBe("validating");
      h.controller.stop(); expect(await changed).toBeInstanceOf(Error);
      expect(workers[1]!.terminate).toHaveBeenCalled(); expect(h.tools.attachAutomaticGrasp).not.toHaveBeenCalled();
      expect(h.controller.snapshot().phase).toBe("stopped");
    } finally { vi.unstubAllGlobals(); }
  });
  it("approaches without contact and waits outside tissue for delayed validation", () => {
    const h = harness(), state = Reflect.get(h.controller, "state");
    state.phase = "approaching"; state.policy = null; state.plan.startOffsetMm = 12;
    Reflect.set(h.controller, "phaseTime", 2);
    h.controller.tick(.016);
    expect(h.tools.previewAutomaticGrasp).toHaveBeenLastCalledWith(state.plan, 2);
    expect(h.controller.snapshot().phase).toBe("checking");
    for (let i = 0; i < 100; i++) h.controller.tick(.05);
    expect(h.tools.attachAutomaticGrasp).not.toHaveBeenCalled(); expect(h.tools.commandAutomaticGrasp).not.toHaveBeenCalled();
    state.policy = { action: 0 }; h.controller.tick(.016);
    expect(h.controller.snapshot().phase).toBe("contacting");
    for (let i = 0; i < 8; i++) h.controller.tick(.05);
    expect(h.tools.attachAutomaticGrasp).toHaveBeenCalledTimes(1); expect(h.controller.snapshot().phase).toBe("closing");
  });
  it("cancels the early approach and never attaches after late validation", () => {
    const h = harness(), state = Reflect.get(h.controller, "state");
    state.phase = "checking"; state.policy = null;
    h.controller.stop(); state.policy = { action: 0 };
    for (let i = 0; i < 100; i++) h.controller.tick(.05);
    expect(h.tools.attachAutomaticGrasp).not.toHaveBeenCalled(); expect(h.tools.commandAutomaticGrasp).not.toHaveBeenCalled();
    expect(h.tools.release).toHaveBeenCalledTimes(1);
  });
  it("waits for an explicit release decision and enforces a bounded hold", () => {
    const h = harness(); Reflect.set(h.controller, "waitForRelease", true); Reflect.set(h.controller, "phaseTime", 2);
    h.controller.tick(.016); expect(h.controller.snapshot().phase).toBe("holding");
    h.controller.requestRelease(); h.controller.tick(.016); expect(h.controller.snapshot().phase).toBe("lowering");
    expect(()=>h.controller.requestRelease()).toThrow();
    const timeout=harness(); Reflect.set(timeout.controller,"waitForRelease",true); Reflect.set(timeout.controller,"phaseTime",15);
    timeout.controller.tick(.016); expect(timeout.controller.snapshot().phase).toBe("blocked"); expect(timeout.tools.release).toHaveBeenCalledTimes(1);
  });
  it("commands a held contact only when the measured state passes every limit", () => {
    const h = harness(); h.controller.tick(1 / 60); expect(h.tools.commandAutomaticGrasp).toHaveBeenCalledWith(2, 1); expect(h.tools.release).not.toHaveBeenCalled();
    h.feedback.tool.forceN = [.81, 0, 0]; h.tools.commandAutomaticGrasp.mockClear(); h.controller.tick(1 / 60);
    expect(h.controller.snapshot().phase).toBe("blocked"); expect(h.tools.release).toHaveBeenCalledTimes(1); expect(h.tools.commandAutomaticGrasp).not.toHaveBeenCalled();
    h.controller.tick(1); expect(h.tools.release).toHaveBeenCalledTimes(1);
  });
  it("cancels immediately when the camera changes and cannot restart on a later frame", () => {
    const h = harness(); h.camera.position.x = .1; h.controller.tick(.016);
    expect(h.controller.snapshot().phase).toBe("stopped"); expect(h.tools.commandAutomaticGrasp).not.toHaveBeenCalled();
    h.camera.position.x = 0; h.controller.tick(.016); expect(h.tools.commandAutomaticGrasp).not.toHaveBeenCalled();
  });
  it("stops if physics is paused or finite contact is lost", () => {
    const h = harness(); h.tools.enabled = false; h.controller.tick(.016); expect(h.controller.snapshot().phase).toBe("stopped");
    const bad = harness(); bad.feedback.finite = false; bad.controller.tick(.016); expect(bad.controller.snapshot().phase).toBe("blocked");
  });
  it("does not execute a stale stage after explicit stop or disposal", () => {
    const h = harness(); h.controller.stop(); h.controller.tick(.016); h.controller.dispose();
    expect(h.tools.release).toHaveBeenCalledTimes(1); expect(h.tools.commandAutomaticGrasp).not.toHaveBeenCalled();
  });
  it("stops before an instrument command if tissue reaches the stationary lens", () => {
    const h = harness(); Reflect.get(h.controller, "c").lensClear = () => false; h.controller.tick(.016);
    expect(h.controller.snapshot().phase).toBe("blocked"); expect(h.tools.commandAutomaticGrasp).not.toHaveBeenCalled(); expect(h.tools.release).toHaveBeenCalledTimes(1);
  });
});
