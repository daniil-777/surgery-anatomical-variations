import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { AutomaticGrasp } from "./automaticGrasp";
function harness() {
  const feedback = { displacement_mm: 1, displacement_gradient_bound: .1, finite: true, tool: { active: true, forceN: [.1, 0, 0], displacementMm: [1, 0, 0], actualSurfacePointMm: [1, 0, 0], residualMm: .1, clamped: false } };
  const tools = { enabled: true, release: vi.fn(), commandAutomaticGrasp: vi.fn() };
  const camera = new THREE.PerspectiveCamera(), publish = vi.fn();
  const controller = new AutomaticGrasp({ tools, camera, physics: () => ({ snapshot: () => feedback }), trainingInput: vi.fn(), publish } as unknown as ConstructorParameters<typeof AutomaticGrasp>[0]);
  const state = { ...controller.snapshot(), phase: "holding", plan: { startOffsetMm: 32 }, policy: { action: 0 } };
  Reflect.set(controller, "state", state); Reflect.set(controller, "cameraRotation", camera.quaternion.clone());
  return { feedback, tools, camera, controller, publish };
}
describe("automatic instrument execution guards", () => {
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
