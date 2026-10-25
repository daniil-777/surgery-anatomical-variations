import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createLaparoscopicInstrument } from "./laparoscopicInstruments";
import { SceneSurfaceContact } from "./wholeSceneContact";
import { WholeSceneTools } from "./wholeSceneTools";

interface GuardWitness {
  blocked: boolean;
  organId: string | null;
  kind: "tip" | "shaft" | "jaw" | null;
  clearanceMm: number;
}

// Exercise the production controller's guard without constructing its unrelated
// canvas/event infrastructure. No guard constants or proxy assembly are copied.
const queryGuard = Reflect.get(WholeSceneTools.prototype, "collision") as (
  this: unknown,
  from: THREE.Vector3, to: THREE.Vector3,
  normal: THREE.Vector3, axis: THREE.Vector3,
  selected: unknown, initial: boolean, anchor: null,
) => GuardWitness;

describe("whole-scene visible instrument guard coverage", () => {
  it("rejects the recorded camera-inside-handle pose before any tissue query",()=>{
    const pose=new THREE.Vector3(67.12,-89.7566,57.3324),axis=new THREE.Vector3(-.697254,.287798,.656512).normalize();
    const harness={c:{options:()=>({mode:"grasp",radius:3}),camera:{position:new THREE.Vector3(-109.3586,-16.811,225.1229)},parts:()=>[]},jawClosure:1,contact:null};
    const guard=queryGuard.call(harness,pose,pose,new THREE.Vector3(0,0,1),axis,{},true,null);
    expect(guard.blocked).toBe(true);expect(guard.organId).toBe("camera");expect(guard.kind).toBe("handle");expect(guard.clearanceMm).toBeLessThan(0);
  });

  for (const fixture of [
    { mode: "push" as const, instrument: "probe" as const, meshName: "probe-distal-neck", sheetZ: 20 },
    { mode: "grasp" as const, instrument: "grasper" as const, meshName: "distal-clevis-tube", sheetZ: 24 },
  ]) {
    it(`blocks a thin sheet through the real ${fixture.meshName}`, () => {
      const instrument = createLaparoscopicInstrument(fixture.instrument);
      const geometry = new THREE.BufferGeometry();
      const material = new THREE.MeshPhysicalMaterial();
      try {
        instrument.setContactRadius(6);
        instrument.setJawClosure(1);
        instrument.group.updateMatrixWorld(true);
        const neck = instrument.group.getObjectByName(fixture.meshName);
        expect(neck, "the tested section must exist in the visible model").toBeDefined();
        const visibleBounds = new THREE.Box3().setFromObject(neck!);
        expect(visibleBounds.min.z).toBeLessThan(fixture.sheetZ);
        expect(visibleBounds.max.z).toBeGreaterThan(fixture.sheetZ);
        expect(visibleBounds.containsPoint(new THREE.Vector3(0, 0, fixture.sheetZ))).toBe(true);

        const positions = new Float32Array([
          -10, -10, fixture.sheetZ, 10, -10, fixture.sheetZ,
          10, 10, fixture.sheetZ, -10, 10, fixture.sheetZ,
        ]);
        const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeBoundingBox();
        const obstacle = {
          info: { id: "thin-crossing-sheet", label: "Thin crossing sheet", category: "connective" },
          mesh: new THREE.Mesh(geometry, material), variant: positions,
        };
        const surface = new SceneSurfaceContact(obstacle.info.id, positions, indices);
        const harness = {
          c: { options: () => ({ mode: fixture.mode, radius: 6 }), parts: () => [obstacle], camera: { position: new THREE.Vector3(1000,1000,1000) } },
          jawClosure: 1, partSurface: () => surface,
          patches: new Map(), currentPatchSize: 0, contact: null,
        };
        const origin = new THREE.Vector3();
        const axis = new THREE.Vector3(0, 0, 1);
        const guard = queryGuard.call(harness, origin, origin, axis, axis, {}, true, null);
        expect(guard.blocked).toBe(true);
        expect(guard.organId).toBe(obstacle.info.id);
        expect(guard.kind).toBe("shaft");
        expect(guard.clearanceMm).toBeLessThan(-2.5);

        // Failure witness: the previous shaft-only interval started at z=30,
        // so it missed this physically occupied neck/clevis section entirely.
        expect(surface.closestCapsule([0, 0, 30], [0, 0, 240], 2.6)).toBeNull();
      } finally {
        instrument.dispose(); geometry.dispose(); material.dispose();
      }
    });
  }
});

// Actual event handlers and real ray picking; only force integration is stubbed.
describe("instrument input continuity", () => {
  function harness(mode: "push" | "grasp", continuousPush = false) {
    const captured = new Set<number>();
    const canvas = Object.assign(new EventTarget(), {
      style: {}, tabIndex: -1,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
      setPointerCapture: (id: number) => captured.add(id), hasPointerCapture: (id: number) => captured.has(id), releasePointerCapture: (id: number) => captured.delete(id),
      focus: () => { Reflect.set(document, "activeElement", canvas); },
    });
    vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("document", { activeElement: null });
    const positions = new Float32Array([-50, -50, 0, 50, -50, 0, 0, 50, 0]);
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3)); geometry.setIndex([0, 1, 2]); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    const material = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide }), mesh = new THREE.Mesh(geometry, material); mesh.updateMatrixWorld(true);
    const part = { info: { id: "surface", label: "Surface", category: "digestive" }, mesh, variant: positions.slice() };
    const camera = new THREE.PerspectiveCamera(45, 1, .1, 1000); camera.position.set(0, 0, 200); camera.lookAt(0, 0, 0); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    const physics = { beginToolContact: vi.fn(), moveToolTarget: vi.fn(), slideToolContact: vi.fn(), releaseToolContact: vi.fn(), toolSnapshot: () => null };
    const options = { mode, radius: 6, depth: 2, running: true, ready: true, selected: "surface", recording: null, continuousPush, pushSpeedMmS: 3 };
    const context = { scene: new THREE.Scene(), camera, canvas, controls: { enabled: true, target: new THREE.Vector3() }, parts: () => [part], physics: () => physics, options: () => options, invalidate: vi.fn(), select: vi.fn(), status: vi.fn() };
    const controller = new WholeSceneTools(context as unknown as ConstructorParameters<typeof WholeSceneTools>[0]);
    controller.syncOptions(); controller.engageSelected();
    const pointer = (name: string, x = 135, y = 105, pointerType = "") => canvas.dispatchEvent(Object.assign(new Event(name, { cancelable: true }), { button: 0, pointerId: 7, pointerType, clientX: x, clientY: y }));
    const key = (key: string) => canvas.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), { key, shiftKey: false }));
    return { controller, canvas, physics, pointer, key, options, cleanup: () => { controller.dispose(); geometry.dispose(); material.dispose(); vi.unstubAllGlobals(); } };
  }
  it("rechecks the first actual pose after re-engaging unchanged tissue", () => {
    const h = harness("push");
    try {
      h.controller.tick(0, 1 / 60);
      const revision = Reflect.get(h.controller, "revision");
      expect(Reflect.get(h.controller, "guardRevision")).toBe(revision);
      h.controller.release(); h.physics.releaseToolContact.mockClear();
      h.controller.engageSelected();
      expect(h.controller.engaged).toBe(true);
      expect(Reflect.get(h.controller, "revision")).toBe(revision);
      // The initial approach passed. A new actual-pose obstruction must still
      // release the instrument before drawing, without waiting for a mesh update.
      const actualCheck = vi.spyOn(h.controller as unknown as { collision: (...args: unknown[]) => unknown }, "collision").mockReturnValue({
        blocked: true, organId: "camera", kind: "handle", clearanceMm: -.2, time: 0, reason: "actual pose obstruction fixture", conservative: true,
      });
      h.controller.tick(1000 / 60, 1 / 60);
      expect(actualCheck).toHaveBeenCalledTimes(1);
      expect((actualCheck.mock.calls[0]![0] as THREE.Vector3).toArray()).toEqual(h.controller.snapshot().visualTipMm);
      expect(h.controller.engaged).toBe(false);
      expect(h.controller.snapshot().instrumentVisible).toBe(false);
      expect(h.controller.snapshot().guard).toMatchObject({ blocked: true, organId: "camera", kind: "handle" });
      expect(h.physics.releaseToolContact).toHaveBeenCalledTimes(1);
    } finally { h.cleanup(); }
  });
  for (const hz of [20, 60]) it(`advances a stationary held push at the selected speed at ${hz} Hz and stops on release`, () => {
    const h = harness("push", true);
    try {
      h.controller.tick(0, .1);
      expect(h.controller.snapshot().depthMm).toBe(2); // Keyboard attachment alone does not start a hold.
      h.pointer("pointerdown", 100, 100, "mouse");
      for (let frame = 0; frame < hz; frame++) h.controller.tick(frame * 1000 / hz, 1 / hz);
      expect(h.controller.snapshot().depthMm).toBeCloseTo(5, 8);
      expect(h.controller.snapshot().holdingPush).toBe(true);
      h.pointer("pointerup", 100, 100, "mouse");
      expect(h.controller.engaged).toBe(false);
      expect(h.controller.snapshot().latched).toBe(false);
      h.physics.moveToolTarget.mockClear();
      h.controller.tick(2000, .1);
      expect(h.physics.moveToolTarget).not.toHaveBeenCalled();
      expect(h.physics.releaseToolContact).toHaveBeenCalledTimes(1);
    } finally { h.cleanup(); }
  });
  it("does not latch even a short click when continuous push is enabled", () => {
    const h = harness("push", true);
    try {
      h.pointer("pointerdown", 100, 100, "mouse"); h.pointer("pointerup", 100, 100, "mouse");
      expect(h.controller.engaged).toBe(false);
      expect(h.controller.snapshot().latched).toBe(false);
    } finally { h.cleanup(); }
  });
  for (const mode of ["push", "grasp"] as const) it(`does not advance an ordinary ${mode} automatically`, () => {
    const h = harness(mode, mode === "grasp");
    try {
      h.pointer("pointerdown"); const depth = h.controller.snapshot().depthMm;
      for (let frame = 0; frame < 60; frame++) h.controller.tick(frame * 1000 / 60, 1 / 60);
      expect(h.controller.snapshot().depthMm).toBe(depth);
      expect(h.physics.moveToolTarget).not.toHaveBeenCalled();
    } finally { h.cleanup(); }
  });
  it("caps long holds at 20 mm and never accumulates blocked insertion", () => {
    const h = harness("push", true);
    try {
      h.pointer("pointerdown");
      const collision = vi.spyOn(h.controller as unknown as { collision: (...args: unknown[]) => unknown }, "collision").mockImplementation((...args) => ({ blocked: !args[5], organId: "neighbour", kind: "shaft", clearanceMm: -.2, time: .4, reason: "fixture", conservative: false }));
      for (let frame = 0; frame < 10; frame++) h.controller.tick(frame * 100, .1);
      expect(h.controller.snapshot().depthMm).toBe(2);
      expect(h.physics.moveToolTarget).not.toHaveBeenCalled();
      // The input fixture has no deforming solver; let the contact advance to
      // exercise its independent depth cap after proving obstruction stops it.
      collision.mockReturnValue({ blocked: false, organId: null, kind: null, clearanceMm: 0, time: 1, reason: "clear", conservative: false });
      for (let frame = 0; frame < 100; frame++) h.controller.tick(frame * 100, .1);
      expect(h.controller.snapshot().depthMm).toBe(20);
      expect(h.controller.snapshot().message).toContain("limit reached");
      h.physics.moveToolTarget.mockClear(); h.controller.tick(12000, 10);
      expect(h.physics.moveToolTarget).not.toHaveBeenCalled();
    } finally { h.cleanup(); }
  });
  for (const interruption of ["pointercancel", "lostpointercapture", "blur", "pause", "disable", "Escape"] as const) it(`stops continuous push after ${interruption}`, () => {
    const h = harness("push", true);
    try {
      h.pointer("pointerdown"); h.controller.tick(100, .1);
      if (interruption === "blur") window.dispatchEvent(new Event("blur"));
      else if (interruption === "pause") { h.options.running = false; h.controller.syncOptions(); }
      else if (interruption === "disable") { h.options.continuousPush = false; h.controller.syncOptions(); }
      else if (interruption === "Escape") h.key("Escape");
      else h.pointer(interruption);
      expect(h.controller.engaged).toBe(false);
      h.physics.moveToolTarget.mockClear(); h.controller.tick(300, .1);
      expect(h.physics.moveToolTarget).not.toHaveBeenCalled();
    } finally { h.cleanup(); }
  });
  for (const mode of ["push", "grasp"] as const) it(`preserves a latched ${mode} target when returning from a sidebar control`, () => {
    const h = harness(mode);
    try {
      h.controller.release(); h.pointer("pointerdown", 100, 100, "mouse"); h.pointer("pointerup", 100, 100, "mouse");
      expect(h.controller.snapshot().latched).toBe(true);
      h.pointer("pointerleave", 201, 100, "mouse"); h.controller.adjustDepth(2);
      const contact = Reflect.get(h.controller, "contact"), target = contact.target.clone();
      h.physics.moveToolTarget.mockClear(); h.physics.slideToolContact.mockClear();
      h.pointer("pointermove", 155, 105, "mouse");
      expect(contact.target.distanceTo(target)).toBeLessThan(1e-8);
      expect(h.physics.moveToolTarget).not.toHaveBeenCalled(); expect(h.physics.slideToolContact).not.toHaveBeenCalled();
      contact.lastSlide = -Infinity; h.pointer("pointermove", 160, 105, "mouse");
      expect(contact.target.distanceTo(target)).toBeGreaterThan(.5);
      expect(h.controller.engaged).toBe(true);
    } finally { h.cleanup(); }
  });
  for (const mode of ["push", "grasp"] as const) it(`transfers a keyboard ${mode} to a pointer without releasing or jumping`, () => {
    const h = harness(mode);
    try {
      expect(h.controller.engaged).toBe(true);
      if (mode === "grasp") h.key("ArrowRight");
      const contact = Reflect.get(h.controller, "contact"), before = contact.target.clone(), face = contact.anchor.triangleIndex;
      h.pointer("pointerdown");
      expect(h.controller.engaged).toBe(true); expect(h.canvas.hasPointerCapture(7)).toBe(true);
      expect(contact.anchor.triangleIndex).toBe(face); expect(contact.target.distanceTo(before)).toBeLessThan(1e-8);
      expect(h.physics.releaseToolContact).not.toHaveBeenCalled();
      contact.lastSlide = -Infinity; h.pointer("pointermove");
      expect(contact.target.distanceTo(before)).toBeLessThan(1e-8);
      contact.lastSlide = -Infinity; h.pointer("pointermove", 143, 105);
      expect(contact.target.distanceTo(before)).toBeGreaterThan(.5);
      h.pointer("pointerup", 143, 105);
      expect(h.controller.engaged).toBe(false); expect(h.canvas.hasPointerCapture(7)).toBe(false);
      expect(h.physics.releaseToolContact).toHaveBeenCalledTimes(1);
    } finally { h.cleanup(); }
  });
  for (const mode of ["push", "grasp"] as const) {
    it(`keeps a clicked ${mode} attached for pointer motion and releases on the next click`, () => {
      const h = harness(mode);
      try {
        h.controller.release(); h.physics.releaseToolContact.mockClear();
        h.pointer("pointerdown", 100, 100, "mouse");
        h.pointer("pointerup", 100, 100, "mouse");
        expect(h.controller.engaged).toBe(true);
        expect(h.controller.snapshot().latched).toBe(true);
        expect(h.canvas.hasPointerCapture(7)).toBe(false);
        const contact = Reflect.get(h.controller, "contact"), before = contact.target.clone();
        contact.lastSlide = -Infinity; h.pointer("pointermove", 115, 100, "mouse");
        expect(contact.target.distanceTo(before)).toBeGreaterThan(.5);
        h.pointer("pointerdown", 115, 100, "mouse");
        expect(h.controller.engaged).toBe(false);
        expect(h.physics.releaseToolContact).toHaveBeenCalledTimes(1);
      } finally { h.cleanup(); }
    });
    it(`still releases a held or dragged ${mode} on mouse up`, () => {
      const h = harness(mode);
      try {
        h.controller.release();
        h.pointer("pointerdown", 100, 100, "mouse");
        Reflect.get(h.controller, "contact").pointerStarted = -Infinity;
        h.pointer("pointerup", 100, 100, "mouse");
        expect(h.controller.engaged).toBe(false);
        h.pointer("pointerdown", 100, 100, "mouse");
        h.pointer("pointermove", 115, 100, "mouse");
        h.pointer("pointerup", 115, 100, "mouse");
        expect(h.controller.engaged).toBe(false);
      } finally { h.cleanup(); }
    });
  }
  it("tries a guarded lateral approach when the first shaft direction is blocked", () => {
    const h = harness("grasp");
    try {
      h.controller.release();
      const collision = vi.spyOn(h.controller as unknown as { collision: (...args: unknown[]) => unknown }, "collision").mockImplementation((...args) => {
        const axis = args[3] as THREE.Vector3;
        return { blocked: Math.abs(axis.x) > .3 || Math.abs(axis.y) > .1, organId: "neighbour", kind: "shaft", clearanceMm: -.2, time: 0, reason: "oblique shaft crosses neighbour", conservative: false };
      });
      h.controller.engageSelected();
      expect(h.controller.engaged).toBe(true);
      expect(collision).toHaveBeenCalledTimes(2);
      expect(Reflect.get(h.controller, "contact").axis.x).toBeGreaterThan(.1);
      expect(Reflect.get(h.controller, "contact").axis.x).toBeLessThan(.3);
      h.controller.release();
      collision.mockReturnValue({ blocked: true, organId: "neighbour", kind: "shaft", clearanceMm: -.2, time: 0, reason: "all approaches blocked", conservative: false });
      h.controller.engageSelected();
      expect(h.controller.engaged).toBe(false);
      expect(h.controller.snapshot().instrumentVisible).toBe(false);
    } finally { h.cleanup(); }
  });
  for (const input of ["keyboard", "pointer"] as const) it(`does not retain a rejected ${input} lateral offset in depth movement`, () => {
    const h = harness("grasp");
    try {
      const contact = Reflect.get(h.controller, "contact"), before = contact.target.clone();
      if (input === "pointer") h.pointer("pointerdown");
      const guard = vi.spyOn(h.controller as unknown as { collision: () => unknown }, "collision").mockReturnValue({ blocked: true, organId: "obstacle", kind: "shaft", clearanceMm: -.2, time: .4, reason: "fixture", conservative: false });
      if (input === "keyboard") h.key("ArrowRight"); else h.pointer("pointermove", 155, 105);
      expect(contact.lateral.length()).toBe(0); expect(contact.target.distanceTo(before)).toBe(0);
      guard.mockReturnValue({ blocked: false, organId: null, kind: null, clearanceMm: 0, time: 1, reason: "clear", conservative: false });
      h.key("PageUp");
      expect(contact.target.x).toBeCloseTo(before.x, 8); expect(contact.target.y).toBeCloseTo(before.y, 8); expect(contact.target.z - before.z).toBeCloseTo(2, 8);
      expect(h.physics.moveToolTarget).toHaveBeenCalled();
    } finally { h.cleanup(); }
  });
});
