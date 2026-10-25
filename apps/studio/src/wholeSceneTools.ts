import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createLaparoscopicInstrument } from "./laparoscopicInstruments";
import { SceneSurfaceContact, type SceneSurfaceHit } from "./wholeSceneContact";
import { instrumentContactEnvelopes } from "./wholeSceneInstrumentEnvelope";
import { toolCapsuleMayMeetBounds } from "./wholeSceneToolBounds";
import { cameraInstrumentClearance, CAMERA_GUARD_RADIUS_MM } from "./wholeSceneCameraClearance";
import type { WholeScenePhysics, SceneToolContactInput } from "./wholeScenePhysics";

export type WholeSceneToolMode = "orbit" | "push" | "grasp";
export interface WholeSceneToolState {
  mode: WholeSceneToolMode; ready: boolean; active: boolean; organId: string | null;
  depthMm: number; radiusMm: number; targetMm: number[] | null; contactPointMm: number[] | null;
  reactionN: number; penetrationMm: number; slipMm: number; message: string;
  continuousPush: boolean; holdingPush: boolean;
}
interface SurfacePart {
  info: { id: string; label: string; category: string };
  mesh: { geometry: THREE.BufferGeometry; material: { side: THREE.Side }; visible: boolean }; variant: Float32Array;
}
interface Options {
  mode: WholeSceneToolMode; radius: number; depth: number; running: boolean; ready: boolean;
  selected: string | null; recording: "tour" | "interaction" | null;
  continuousPush?: boolean; pushSpeedMmS?: number;
}
interface Context {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; canvas: HTMLCanvasElement;
  parts: () => SurfacePart[]; physics: () => WholeScenePhysics | null; options: () => Options;
  obstacles?: () => SurfacePart[];
  invalidate: (shadows?: boolean) => void; select: (id: string) => void;
  status: (state: WholeSceneToolState) => void;
  interrupt?: (reason: string) => void;
}
export interface AutomaticGraspPlan {
  contact: SceneToolContactInput; axis: [number, number, number]; startOffsetMm: number;
  triangleIndex: number; candidateCount: number;
}
interface Anchor extends SceneSurfaceHit { part: SurfacePart }
interface Contact {
  anchor: Anchor; normal: THREE.Vector3; axis: THREE.Vector3; target: THREE.Vector3;
  base: THREE.Vector3; baseOffset: THREE.Vector3; lateral: THREE.Vector3;
  plane: THREE.Plane; planeStart: THREE.Vector3; depth: number; mode: "push" | "grasp";
  pointer: number | null; client: THREE.Vector2; pointerOffset: THREE.Vector2; lastSlide: number;
  pointerStarted: number; pointerStart: THREE.Vector2; latched: boolean;
}
interface Guard {
  blocked: boolean; organId: string | null; kind: "tip" | "shaft" | "jaw" | "handle" | null;
  clearanceMm: number; time: number; reason: string; conservative: boolean;
}
const clearGuard = (): Guard => ({ blocked: false, organId: null, kind: null, clearanceMm: 0, time: 1, reason: "clear", conservative: false });
const vec = (p: number[]) => new THREE.Vector3(p[0], p[1], p[2]);
const array = (p: THREE.Vector3): [number, number, number] => [p.x, p.y, p.z];
const vertex = (p: ArrayLike<number>, i: number): [number, number, number] => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];

/** Triangle-attached input and geometric instrument guards. The shared source atlas
 * remains unchanged. Each articulated jaw and the working metal have measured
 * conservative capsule envelopes; neither the pistol grip nor friction, cutting, or tissue failure are simulated. */
export class WholeSceneTools {
  private readonly probe = createLaparoscopicInstrument("probe");
  private readonly grasper = createLaparoscopicInstrument("grasper");
  private readonly ray = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly requestedMarker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly targetLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly cache = new Map<string, { surface: SceneSurfaceContact; revision: number; variant: Float32Array }>();
  private revision = 0;
  private contact: Contact | null = null;
  private rebaseOnReentry = false;
  private lastAnchor: Anchor | null = null;
  private hover: Anchor | null = null;
  private lastMode: WholeSceneToolMode = "orbit";
  private lastRadius = 6;
  private lastContinuousPush = false;
  private message = "Apply and run learned physics to use an instrument.";
  private guard: Guard = clearGuard();
  private jawClosure = 0;
  private automaticJaw: number | null = null;
  private automaticAnchor: Anchor | null = null;
  private preview: { plan: AutomaticGraspPlan; point: THREE.Vector3 } | null = null;
  private lastStatus = -Infinity;
  private lastHover = -Infinity;
  private disposed = false;
  private candidates: Record<string, unknown>[] = [];
  private candidateStamp = "";
  private candidateTime = -Infinity;
  private poseOrigin = new THREE.Vector3();
  private tipCenter = new THREE.Vector3();
  private visualTip = new THREE.Vector3();
  private lastNormal = new THREE.Vector3(0, 0, 1);
  private lastAxis = new THREE.Vector3(0, 0, 1);
  private measuredPenetration = 0;
  private geometricClearance = 0;
    private readonly patches = new Map<string, ReadonlySet<number>>();
  private currentPatchSize = 0;
  private guardRevision = -1;
  private lastGuardJaw = -1;
  constructor(private readonly c: Context) {
    c.scene.add(this.probe.group, this.grasper.group);
    this.probe.group.visible = this.grasper.group.visible = false;
    this.requestedMarker = new THREE.Mesh(new THREE.SphereGeometry(1.15, 12, 8), new THREE.MeshBasicMaterial({ color: 0xefb96c, transparent: true, opacity: .85, depthTest: false, depthWrite: false }));
    this.targetLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xefb96c, transparent: true, opacity: .7, depthTest: false, depthWrite: false }));
    this.requestedMarker.renderOrder = this.targetLine.renderOrder = 10;
    this.requestedMarker.visible = this.targetLine.visible = false;
    c.scene.add(this.requestedMarker, this.targetLine);
    c.canvas.tabIndex = 0;
    c.canvas.addEventListener("pointerdown", this.onDown, true);
    c.canvas.addEventListener("pointermove", this.onMove, true);
    c.canvas.addEventListener("pointerup", this.onUp, true);
    c.canvas.addEventListener("pointercancel", this.onCancel, true);
    c.canvas.addEventListener("lostpointercapture", this.onLost, true);
    c.canvas.addEventListener("pointerleave", this.onLeave);
    c.canvas.addEventListener("wheel", this.onWheel, { capture: true, passive: false });
    c.canvas.addEventListener("keydown", this.onKey);
    window.addEventListener("blur", this.onBlur);
  }
  get engaged() { return Boolean(this.contact); }
  private get holdingPush() { return Boolean(this.c.options().continuousPush && this.contact?.mode === "push" && this.contact.pointer !== null); }
  get available() { const o = this.c.options(); return o.ready && Boolean(this.c.physics()); }
  get enabled() { const o = this.c.options(); return this.available && o.running && o.mode !== "orbit" && o.recording !== "tour"; }
  lensClear(radiusMm = 2.01) {
    for (const part of [...this.c.parts(), ...(this.c.obstacles?.() ?? [])]) {
      if (!part.mesh.visible || (part.mesh.geometry.boundingBox && part.mesh.geometry.boundingBox.distanceToPoint(this.c.camera.position) > radiusMm)) continue;
      if (this.partSurface(part).closestPoint(array(this.c.camera.position), radiusMm)) return false;
    }
    return true;
  }
  private partSurface(part: SurfacePart) {
    let cached = this.cache.get(part.info.id);
    if (!cached || cached.variant !== part.variant) {
      const index = part.mesh.geometry.index;
      const indices = index ? new Uint32Array(index.array) : Uint32Array.from({ length: part.variant.length / 3 }, (_, i) => i);
      cached = { surface: new SceneSurfaceContact(part.info.id, part.variant, indices), revision: -1, variant: part.variant };
      this.cache.set(part.info.id, cached);
    }
    if (cached.revision !== this.revision && !(part.info.category === "skeleton" && cached.revision >= 0)) {
      cached.surface.refit(part.mesh.geometry.getAttribute("position").array as Float32Array);
      cached.revision = this.revision;
    }
    return cached.surface;
  }
  geometryChanged(reset = false) {
    this.revision++;
    if (reset) { this.release("Surface variation changed; choose a new contact."); this.cache.clear(); this.patches.clear(); this.hover = this.lastAnchor = null; this.candidateStamp = ""; }
  }
  syncOptions() {
    const o = this.c.options();
    if (this.contact && (!this.enabled || this.lastMode !== o.mode || this.lastRadius !== o.radius || this.lastContinuousPush !== Boolean(o.continuousPush) || !this.contact.anchor.part.mesh.visible)) this.release("Instrument released after scene settings changed.");
    if (this.lastMode !== o.mode || this.lastRadius !== o.radius) { this.hover = null; this.guard = clearGuard(); this.message = o.mode === "orbit" ? "Orbit to expose a surface, then choose Push or Grasp." : "Click a visible surface to attach, or hold and drag."; this.c.invalidate(true); }
    this.lastMode = o.mode; this.lastRadius = o.radius;
    this.lastContinuousPush = Boolean(o.continuousPush);
    this.probe.setContactRadius(o.radius);
    this.c.controls.enabled = !this.contact && o.recording !== "interaction";
    this.c.canvas.style.cursor = this.enabled ? this.contact ? "grabbing" : "crosshair" : "grab";
    this.c.canvas.style.touchAction = "none";
    this.publish(true);
  }
  private setRay(x: number, y: number) {
    const rect = this.c.canvas.getBoundingClientRect();
    this.pointer.set((x - rect.left) / rect.width * 2 - 1, -(y - rect.top) / rect.height * 2 + 1);
    this.c.camera.updateMatrixWorld(); this.ray.setFromCamera(this.pointer, this.c.camera);
  }
  private pick(x: number, y: number): Anchor | null {
    this.setRay(x, y);
    // The translucent scaffold is a selectable occluder for tools as well as a
    // collision obstacle. Hide it in the inspection UI to expose deeper surfaces.
    let nearest: Anchor | null = null;
    const origin = array(this.ray.ray.origin), direction = array(this.ray.ray.direction);
    for (const part of [...this.c.parts(), ...(this.c.obstacles?.() ?? [])]) {
      if (!part.mesh.visible || (part.mesh.geometry.boundingBox && !this.ray.ray.intersectsBox(part.mesh.geometry.boundingBox))) continue;
      const side = part.mesh.material.side === THREE.FrontSide ? "front" : part.mesh.material.side === THREE.BackSide ? "back" : "double";
      const hit = this.partSurface(part).raycast(origin, direction, side, nearest?.distanceMm ?? Infinity);
      if (hit && (!nearest || hit.distanceMm < nearest.distanceMm)) nearest = { ...hit, part };
    }
    return nearest && ["skeleton", "occluder"].includes(nearest.part.info.category) ? null : nearest;
  }
  private triangle(anchor: Anchor) {
    const p = anchor.part.mesh.geometry.getAttribute("position");
    return anchor.vertexIndices.map(i => [p.getX(i), p.getY(i), p.getZ(i)]) as [number[], number[], number[]];
  }
  private renderedPoint(anchor: Anchor) {
    const point = new THREE.Vector3(); this.triangle(anchor).forEach((p, i) => point.addScaledVector(vec(p), anchor.barycentric[i]!)); return point;
  }
  private displayedNormal(anchor: Anchor) {
    const t = this.triangle(anchor).map(vec);
    const n = new THREE.Vector3().crossVectors(t[1]!.clone().sub(t[0]!), t[2]!.clone().sub(t[0]!)).normalize();
    if (n.dot(vec(anchor.normal)) < 0) n.negate();
    return n.lengthSq() ? n : vec(anchor.normal);
  }
  private input(contact: Contact): SceneToolContactInput {
    const a = contact.anchor;
    return { mode: contact.mode, organId: a.organId, restPointMm: a.restPointMm, normal: array(contact.normal), targetPointMm: array(contact.target), radiusMm: contact.mode === "grasp" ? 3 : this.c.options().radius,
      attachment: { verticesMm: [vertex(a.part.variant, a.vertexIndices[0]), vertex(a.part.variant, a.vertexIndices[1]), vertex(a.part.variant, a.vertexIndices[2])], barycentric: a.barycentric } };
  }
  private approachAxis(normal: THREE.Vector3) {
    const direction = this.c.camera.getWorldDirection(new THREE.Vector3()).negate();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.c.camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.c.camera.quaternion);
    direction.addScaledVector(right, .55).addScaledVector(up, .3).normalize();
    if (direction.dot(normal) < .4) direction.addScaledVector(normal, .9).normalize();
    return direction;
  }
  private collision(from: THREE.Vector3, to: THREE.Vector3, normal: THREE.Vector3, axis: THREE.Vector3, selected: SurfacePart, initial = false, anchor: Anchor | null = this.contact?.anchor ?? null, fromNormal: THREE.Vector3 = normal, marginMm = 0): Guard {
    const radius = this.c.options().radius, push = this.c.options().mode === "push";
    const tipFrom = from.clone().addScaledVector(fromNormal, push ? radius : 0), tipTo = to.clone().addScaledVector(normal, push ? radius : 0);
    const originFrom = push ? tipFrom.clone().addScaledVector(axis, -radius) : from.clone();
    const originTo = push ? tipTo.clone().addScaledVector(axis, -radius) : to.clone();
    const cameraClearance = cameraInstrumentClearance(this.c.camera.position, originFrom, originTo, axis, push ? "push" : "grasp", radius, this.jawClosure);
    if(cameraClearance.clearanceMm < marginMm) return {blocked:true,organId:"camera",kind:cameraClearance.kind,clearanceMm:cameraClearance.clearanceMm,time:0,reason:"The instrument would intersect the camera clearance envelope.",conservative:true};
    const orientation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    const envelopes = instrumentContactEnvelopes(push ? "push" : "grasp", radius, this.jawClosure).map(envelope => {
      const start = vec(envelope.startMm).applyQuaternion(orientation), end = vec(envelope.endMm).applyQuaternion(orientation);
      return { ...envelope, radiusMm: envelope.radiusMm + marginMm, fromStart: start.clone().add(originFrom), fromEnd: end.clone().add(originFrom), toStart: start.clone().add(originTo), toEnd: end.clone().add(originTo) };
    });
    let result = clearGuard();
    const queryBox = new THREE.Box3().setFromPoints([tipFrom, tipTo, ...envelopes.flatMap(envelope => [envelope.fromStart, envelope.fromEnd, envelope.toStart, envelope.toEnd])]).expandByScalar(Math.max(push ? radius : 0, ...envelopes.map(e => e.radiusMm)));
    const accept = (hit: Guard) => {
      if (!result.blocked || hit.time < result.time - 1e-8 || (Math.abs(hit.time - result.time) <= 1e-8 && hit.clearanceMm < result.clearanceMm)) result = hit;
    };
    for (const part of [...this.c.parts(), ...(this.c.obstacles?.() ?? [])]) {
      if (!part.mesh.visible) continue;
      const box = part.mesh.geometry.boundingBox;
      if (box && !queryBox.intersectsBox(box)) continue;
      // Static capsule-vs-expanded-AABB rejection is tighter than the large
      // diagonal sweep box. It is only a broad phase; every retained candidate
      // still receives exact current-triangle contact tests below.
      const tipMayMeet = push && (!box || !initial || toolCapsuleMayMeetBounds(tipTo, tipTo, radius, box));
      const candidates = initial && box ? envelopes.filter(e => toolCapsuleMayMeetBounds(e.toStart, e.toEnd, e.radiusMm, box)) : envelopes;
      if (!tipMayMeet && !candidates.length) continue;
      const surface = this.partSurface(part);
      let ignore: ReadonlySet<number> | undefined;
      if (part === selected && anchor) {
        const patchRadius = push ? radius * 2 : 25;
        const key = `${part.info.id}:${anchor.triangleIndex}:${patchRadius}:${anchor.restPointMm.map(v => v.toFixed(2))}`;
        ignore = this.patches.get(key);
        if (!ignore) { ignore = surface.contactPatch(anchor.triangleIndex, anchor.restPointMm, patchRadius); if (this.patches.size > 30) this.patches.clear(); this.patches.set(key, ignore); }
        this.currentPatchSize = ignore.size;
      }
      if (tipMayMeet) {
        const closest = initial ? surface.closestPoint(array(tipTo), radius, ignore) : null;
        const sphere = initial ? closest ? { ...closest, time: 0, penetrationMm: radius - closest.distanceMm } : null : surface.sweepSphere(array(tipFrom), array(tipTo), radius, ignore);
        if (sphere && (initial ? sphere.penetrationMm > .05 : sphere.time < 1 - 1e-6)) accept({ blocked: true, organId: part.info.id, kind: "tip", clearanceMm: -sphere.penetrationMm, time: sphere.time, reason: "The finite probe meets a visible surface.", conservative: false });
      }
      for (const envelope of candidates) {
        const excluded = envelope.allowContactPatch ? ignore : undefined;
        const hit = initial ? surface.closestCapsule(array(envelope.toStart), array(envelope.toEnd), envelope.radiusMm, excluded) : surface.sweepCapsule(array(envelope.fromStart), array(envelope.fromEnd), array(envelope.toStart), array(envelope.toEnd), envelope.radiusMm, excluded);
        if (hit && (initial ? hit.penetrationMm > .05 : hit.time < 1 - 1e-6)) accept({ blocked: true, organId: part.info.id, kind: envelope.kind, clearanceMm: hit.clearanceMm, time: hit.time, reason: `The ${envelope.label.replaceAll("-", " ")} meets a visible surface.`, conservative: hit.conservativeStop });
      }
    }
    return result;
  }
  private engage(anchor: Anchor, x: number, y: number, pointer: number | null, automaticAxis?: THREE.Vector3) {
    if (!this.enabled) return;
    this.release("", Boolean(automaticAxis)); this.guard = clearGuard();
    // A finite ball can first touch an adjacent face/edge before its centre reaches
    // the ray-picked triangle. Attach the pressure patch to that exact swept hit.
    if (this.c.options().mode === "push") {
      const radius = this.c.options().radius, picked = this.renderedPoint(anchor), n = vec(anchor.normal);
      const hit = this.partSurface(anchor.part).sweepSphere(array(picked.clone().addScaledVector(n, radius + 35)), array(picked.clone().addScaledVector(n, radius)), radius);
      if (hit) anchor = { ...hit, part: anchor.part };
    }
    const normal = vec(anchor.normal), base = this.renderedPoint(anchor), axis = automaticAxis?.clone() ?? this.approachAxis(normal);
    this.guard = this.collision(base, base, normal, axis, anchor.part, true, anchor);
    // Camera and instrument occupy separate access paths. The earlier direct
    // camera-axis fallback could put the lens inside the shaft or blue handle.
    // Try modest lateral offsets before wider alternatives; every candidate
    // receives the same full tissue and camera-clearance guards.
    if (this.guard.blocked && !automaticAxis) {
      const towardCamera = this.c.camera.position.clone().sub(base).normalize();
      const right = new THREE.Vector3(1,0,0).applyQuaternion(this.c.camera.quaternion);
      const up = new THREE.Vector3(0,1,0).applyQuaternion(this.c.camera.quaternion);
      const approaches: THREE.Vector3[] = [];
      for(const offset of [.18,.32,.6]) for(const angle of [0,Math.PI/2,Math.PI,Math.PI*1.5])
        approaches.push(towardCamera.clone().addScaledVector(right,offset*Math.cos(angle)).addScaledVector(up,offset*Math.sin(angle)).normalize());
      approaches.push(normal.clone(),towardCamera);
      for(const candidate of approaches){axis.copy(candidate);this.guard=this.collision(base,base,normal,axis,anchor.part,true,anchor);if(!this.guard.blocked)break;}
    }
    this.hover = this.lastAnchor = anchor;
    if (this.guard.blocked) { this.message = this.guard.organId === "camera" ? "The instrument would intersect the scope. Change the camera angle or choose another exposed contact point." : `Approach blocked by ${this.guard.organId}. Orbit or hide that structure to expose this surface.`; this.c.invalidate(true); this.publish(true); return; }
    const mode = this.c.options().mode as "push" | "grasp";
    const depth = mode === "push" ? this.c.options().depth : 0;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.c.camera.getWorldDirection(new THREE.Vector3()), base);
    this.setRay(x, y); const planeStart = this.ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? base.clone();
    this.contact = { anchor, normal, axis, base: base.clone(), baseOffset: base.clone().sub(vec(anchor.restPointMm)), lateral: new THREE.Vector3(), target: base.clone().addScaledVector(normal, -depth), plane, planeStart, depth, mode, pointer, client: new THREE.Vector2(x, y), pointerOffset: new THREE.Vector2(), lastSlide: performance.now(), pointerStarted: performance.now(), pointerStart: new THREE.Vector2(x, y), latched: false };
    this.c.physics()!.beginToolContact(this.input(this.contact));
    // A new contact's displayed tip may receive an outward clearance projection,
    // even when its tissue revision matches the previously released contact.
    this.guardRevision = -1;
    if (!automaticAxis) this.c.select(anchor.organId); this.c.controls.enabled = false;
    if (automaticAxis) this.automaticJaw = 0;
    this.message = `${mode === "push" ? "Pushing" : "Grasping"} ${anchor.part.info.label}. Move laterally; scroll for depth; Escape releases.`;
    if (pointer !== null) { try { this.c.canvas.setPointerCapture(pointer); } catch { /* A released native pointer can race this synchronous capture. */ } }
    this.c.canvas.focus({ preventScroll: true }); this.c.invalidate(true); this.publish(true);
  }
  engageSelected() {
    const rect = this.c.canvas.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const anchor = this.pick(x, y);
    if (anchor) this.engage(anchor, x, y, null);
    else { this.message = "No exposed soft surface at the view centre. Orbit, focus, or hide an overlying structure."; this.publish(true); }
  }
  /** Current visible triangles only. All poses, closure samples and the complete
   * insertion/traction sweep use the production instrument + camera guards. */
  async planAutomaticGrasp(organId: string, signal: AbortSignal): Promise<AutomaticGraspPlan> {
    if (!this.enabled || this.c.options().mode !== "grasp" || organId !== "liver") throw new Error("Run liver physics and enable the grasper before planning contact.");
    this.release("", true); this.jawClosure = 0;
    const candidates = this.pickCandidates(organId);
    let tried = 0;
    for (const candidate of candidates) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      signal.throwIfAborted();
      const anchor = this.pick(Number(candidate.clientX), Number(candidate.clientY));
      if (!anchor || anchor.organId !== organId) continue;
      const base = this.renderedPoint(anchor), normal = this.displayedNormal(anchor);
      const toward = this.c.camera.position.clone().sub(base).normalize();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.c.camera.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.c.camera.quaternion);
      const axes = [this.approachAxis(normal)];
      for (const offset of [.32, .6, .9]) for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) axes.push(toward.clone().addScaledVector(right, offset * Math.cos(angle)).addScaledVector(up, offset * Math.sin(angle)).normalize());
      for (const axis of axes) {
        tried++;
        if (axis.dot(normal) < .35) continue;
        let blocked = false;
        // 1.2 mm extra planning clearance covers the <.42 mm jaw-tip arc
        // between closure samples and leaves room for small coupled motion.
        for (let step = 0; step <= 20; step++) {
          const closure = step / 20;
          this.jawClosure = closure;
          if (this.collision(base, base, normal, axis, anchor.part, true, anchor, normal, 1.2).blocked) { blocked = true; break; }
        }
        if (!blocked && this.collision(base, base.clone().addScaledVector(normal, 4), normal, axis, anchor.part, false, anchor, normal, 1.2).blocked) blocked = true;
        this.jawClosure = 0;
        const startOffsetMm = 32, start = base.clone().addScaledVector(axis, startOffsetMm);
        if (blocked || this.collision(start, start, normal, axis, anchor.part, true, anchor, normal, 1.2).blocked || this.collision(start, base, normal, axis, anchor.part, false, anchor, normal, 1.2).blocked) continue;
        // Keep the actual attachment and typed worker input separate: no mesh or
        // Three.js object crosses the worker boundary.
        this.automaticAnchor = anchor;
        return { contact: { mode: "grasp", organId, restPointMm: [...anchor.restPointMm], normal: array(normal), targetPointMm: array(base), radiusMm: 3,
          attachment: { verticesMm: [vertex(anchor.part.variant, anchor.vertexIndices[0]), vertex(anchor.part.variant, anchor.vertexIndices[1]), vertex(anchor.part.variant, anchor.vertexIndices[2])], barycentric: [...anchor.barycentric] } },
          axis: array(axis), startOffsetMm, triangleIndex: anchor.triangleIndex, candidateCount: tried };
      }
    }
    this.jawClosure = 0;
    throw new Error("No exposed liver patch admits the full grasper from this view. Change the scope angle and try again.");
  }
  previewAutomaticGrasp(plan: AutomaticGraspPlan, offsetMm: number, closure = 0) {
    const anchor = this.automaticAnchor;
    if (!this.enabled || !anchor || anchor.triangleIndex !== plan.triangleIndex || !anchor.part.mesh.visible || !Number.isFinite(offsetMm) || offsetMm < 0 || offsetMm > plan.startOffsetMm || !Number.isFinite(closure) || closure < 0 || closure > 1) throw new Error("The grasp approach is no longer available.");
    const axis = vec(plan.axis), normal = vec(plan.contact.normal), point = vec(plan.contact.targetPointMm).addScaledVector(axis, offsetMm);
    this.jawClosure = closure;
    const guard = this.collision(this.preview?.point ?? point, point, normal, axis, anchor.part, !this.preview, anchor);
    if (guard.blocked) { this.guard = guard; throw new Error(`Grasper approach blocked by ${guard.organId} (${guard.kind}).`); }
    this.preview = { plan, point }; this.c.controls.enabled = false; this.c.invalidate(true);
  }
  attachAutomaticGrasp(plan: AutomaticGraspPlan) {
    const anchor = this.automaticAnchor;
    if (!anchor || anchor.triangleIndex !== plan.triangleIndex || this.renderedPoint(anchor).distanceTo(vec(plan.contact.targetPointMm)) > .15) throw new Error("Tissue moved before grasp attachment. Plan a fresh task.");
    const rect = this.c.canvas.getBoundingClientRect();
    this.engage(anchor, rect.left + rect.width / 2, rect.top + rect.height / 2, null, vec(plan.axis));
    this.automaticAnchor = anchor;
    if (!this.contact) throw new Error(this.message);
  }
  commandAutomaticGrasp(offsetMm: number, closure: number) {
    if (!this.contact || this.automaticJaw === null || !this.enabled) throw new Error("Automatic grasp contact was interrupted.");
    if (!Number.isFinite(offsetMm) || offsetMm < 0 || offsetMm > 4 || !Number.isFinite(closure) || closure < 0 || closure > 1) throw new Error("Automatic grasp command exceeds its bounded action space.");
    this.automaticJaw = closure;
    if (!this.moveTarget(this.contact.base.clone().addScaledVector(this.contact.normal, offsetMm))) throw new Error(this.message);
    this.contact.depth = -offsetMm;
  }
  detachAutomaticGrasp() {
    const anchor = this.automaticAnchor;
    this.release("Tissue released; withdrawing the grasper.", true); this.automaticAnchor = anchor;
  }
  private moveTarget(target: THREE.Vector3) {
    const contact = this.contact; if (!contact) return false;
    const guard = this.collision(contact.target, target, contact.normal, contact.axis, contact.anchor.part);
    this.guard = guard;
    if (guard.blocked) { this.message = `Motion blocked by ${guard.organId} (${guard.kind}). Withdraw or change the approach.`; this.publish(true); return false; }
    contact.target.copy(target); this.c.physics()?.moveToolTarget(array(target), array(contact.normal));
    this.message = `${contact.mode === "push" ? "Pushing" : "Grasping"} ${contact.anchor.part.info.label}. Move laterally; scroll for depth; Escape releases.`;
    this.c.invalidate(true); return true;
  }
  adjustDepth(delta: number, publish = true) {
    if (this.automaticJaw !== null || this.preview) this.c.interrupt?.("Manual depth control selected; automatic task stopped.");
    if (!this.contact || !this.enabled || !Number.isFinite(delta)) return;
    const c = this.contact, previous = c.depth;
    c.depth = THREE.MathUtils.clamp(c.depth + delta, -20, 20);
    const target = c.base.clone().add(c.lateral).addScaledVector(c.normal, -c.depth);
    this.moveTarget(target); if (this.guard.blocked) c.depth = previous;
    this.publish(publish);
  }
  private moveLateral(dx: number, dy: number) {
    const c = this.contact; if (!c) return;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.c.camera.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.c.camera.quaternion);
    if (c.mode === "push") {
      const point = this.renderedPoint(c.anchor).addScaledVector(right, dx).addScaledVector(up, dy).project(this.c.camera);
      const rect = this.c.canvas.getBoundingClientRect(); this.drag(rect.left + (point.x + 1) * .5 * rect.width, rect.top + (1 - point.y) * .5 * rect.height, true);
    } else {
      const lateral = c.lateral.clone().addScaledVector(right, dx).addScaledVector(up, dy);
      if (this.moveTarget(c.base.clone().add(lateral).addScaledVector(c.normal, -c.depth))) {
        // A later pointer movement continues from the keyboard-adjusted target.
        c.planeStart.add(c.lateral).sub(lateral); c.lateral.copy(lateral);
      }
    }
  }
  private drag(x: number, y: number, force = false) {
    const c = this.contact; if (!c) return;
    if (!force) c.client.set(x, y);
    if (c.mode === "push") {
      if (!force && performance.now() - c.lastSlide < 65) return;
      c.lastSlide = performance.now(); const next = this.pick(x + (force ? 0 : c.pointerOffset.x), y + (force ? 0 : c.pointerOffset.y));
      if (!next || next.organId !== c.anchor.organId) { this.message = "Keep the probe over the contacted organ, or release to choose another surface."; return; }
      if (vec(next.restPointMm).distanceTo(vec(c.anchor.restPointMm)) < .5) return;
      const previous = c.anchor, previousNormal = c.normal.clone(), previousBase = c.base.clone();
      const normal = vec(next.normal), base = vec(next.restPointMm).add(c.baseOffset), target = base.clone().addScaledVector(normal, -c.depth);
      const guard = this.collision(c.target, target, normal, c.axis, next.part, false, next, c.normal);
      this.guard = guard; if (guard.blocked) { this.message = `Motion blocked by ${guard.organId} (${guard.kind}).`; return; }
      c.anchor = next; c.normal.copy(normal); c.base.copy(base); c.lateral.set(0, 0, 0); c.target.copy(target);
      try {
        this.c.physics()?.slideToolContact(this.input(c)); this.lastAnchor = next;
        if (force && c.pointer !== null) this.rebasePointerOffset(c);
      }
      catch (error) { c.anchor = previous; c.normal.copy(previousNormal); c.base.copy(previousBase); this.release(error instanceof Error ? error.message : "Surface contact failed."); }
    } else {
      this.setRay(x, y); const point = this.ray.ray.intersectPlane(c.plane, new THREE.Vector3()); if (!point) return;
      const delta = point.sub(c.planeStart); if (delta.length() > 35) delta.setLength(35);
      if (this.moveTarget(c.base.clone().add(delta).addScaledVector(c.normal, -c.depth))) c.lateral.copy(delta);
    }
    this.c.invalidate(true);
  }
  release(message = "Instrument released; the tissue recovers through its learned viscoelastic response.", automatic = false) {
    if (!automatic) this.c.interrupt?.(message || "Manual instrument control selected.");
    this.preview = null; this.automaticJaw = null;
    const contact = this.contact; this.contact = null; this.rebaseOnReentry = false;
    if (contact) { this.lastAnchor = contact.anchor; this.c.physics()?.releaseToolContact(); }
    if (contact?.pointer !== null && contact?.pointer !== undefined) { try { if (this.c.canvas.hasPointerCapture(contact.pointer)) this.c.canvas.releasePointerCapture(contact.pointer); } catch { /* Native cancellation may already have released it. */ } }
    this.c.controls.enabled = this.c.options().recording !== "interaction";
    this.hover = null; this.probe.group.visible = this.grasper.group.visible = false;
    this.requestedMarker.visible = this.targetLine.visible = false;
    if (message) this.message = message;
    this.c.invalidate(true); this.publish(true);
  }
  private rebasePointerOffset(contact: Contact) {
    const projected = this.renderedPoint(contact.anchor).project(this.c.camera), rect = this.c.canvas.getBoundingClientRect();
    contact.pointerOffset.set(rect.left + (projected.x + 1) * .5 * rect.width - contact.client.x, rect.top + (1 - projected.y) * .5 * rect.height - contact.client.y);
  }
  private consume(event: Event) { event.preventDefault(); event.stopImmediatePropagation(); }
  private onDown = (event: PointerEvent) => {
    if (!this.enabled || event.button !== 0) return;
    this.c.interrupt?.("Manual instrument control selected.");
    this.consume(event);
    if (this.contact) {
      const contact = this.contact;
      if (contact.latched) { this.release(); return; }
      if (contact.pointer !== null) { this.release("Multiple pointers release the instrument."); return; }
      // An Enter/button attachment has no native pointer yet. Transfer control
      // to this pointer without changing the attachment or accepted target.
      this.setRay(event.clientX, event.clientY);
      const planePoint = this.ray.ray.intersectPlane(contact.plane, new THREE.Vector3());
      if (!planePoint) return;
      contact.planeStart.copy(planePoint).sub(contact.lateral);
      contact.pointer = event.pointerId; contact.client.set(event.clientX, event.clientY);
      contact.pointerStarted = performance.now(); contact.pointerStart.set(event.clientX, event.clientY);
      this.rebasePointerOffset(contact);
      try { this.c.canvas.setPointerCapture(event.pointerId); } catch { /* A native cancellation may race capture. */ }
      this.c.canvas.focus({ preventScroll: true }); this.publish(true); return;
    }
    const anchor = this.pick(event.clientX, event.clientY);
    if (anchor) this.engage(anchor, event.clientX, event.clientY, event.pointerId);
    else { this.message = "Select an exposed soft-organ surface. The bone scaffold is fixed."; this.publish(true); }
  };
  private onMove = (event: PointerEvent) => {
    if (!this.enabled) return;
    if (this.automaticJaw !== null || this.preview) return;
    if (this.contact) {
      this.consume(event);
      if (this.contact.latched && this.rebaseOnReentry) {
        // Visiting a depth control must not turn the next canvas entry into a
        // large tissue drag. Rebase the cursor while retaining the accepted pose.
        const contact = this.contact;
        contact.client.set(event.clientX, event.clientY); this.setRay(event.clientX, event.clientY);
        const planePoint = this.ray.ray.intersectPlane(contact.plane, new THREE.Vector3());
        if (planePoint) contact.planeStart.copy(planePoint).sub(contact.lateral);
        this.rebasePointerOffset(contact); this.rebaseOnReentry = false;
        return;
      }
      if (this.contact.latched || this.contact.pointer === event.pointerId) this.drag(event.clientX, event.clientY);
      return;
    }
    if (performance.now() - this.lastHover < 65) return;
    this.lastHover = performance.now(); this.hover = this.pick(event.clientX, event.clientY); this.c.invalidate(true);
  };
  private onUp = (event: PointerEvent) => {
    const contact = this.contact;
    if (contact?.pointer !== event.pointerId) return;
    this.consume(event);
    // A short mouse click attaches persistently; a held/dragged pointer still
    // releases normally. This also avoids a click vanishing before tissue moves.
    if (!this.holdingPush && event.pointerType === "mouse" && performance.now() - contact.pointerStarted < 300 && contact.pointerStart.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) < 4) {
      contact.pointer = null; contact.latched = true;
      if (this.c.canvas.hasPointerCapture(event.pointerId)) this.c.canvas.releasePointerCapture(event.pointerId);
      this.message = "Instrument attached. Move the pointer; click again or press Escape to release.";
      this.publish(true); return;
    }
    this.release();
  };
  private onCancel = (event: PointerEvent) => { if (this.contact?.pointer === event.pointerId) { this.consume(event); this.release("Pointer cancelled; instrument released."); } };
  private onLost = (event: PointerEvent) => { if (this.contact?.pointer === event.pointerId) this.release("Pointer capture lost; instrument released."); };
  private onLeave = () => { if (this.contact?.latched) this.rebaseOnReentry = true; else if (!this.contact) { this.hover = null; this.c.invalidate(true); } };
  private onBlur = () => this.release("Window focus changed; instrument released.");
  private onWheel = (event: WheelEvent) => { if (this.contact && this.enabled) { this.consume(event); this.adjustDepth(Math.sign(event.deltaY) * .75); } };
  private onKey = (event: KeyboardEvent) => {
    if (document.activeElement !== this.c.canvas) return;
    if ((this.automaticJaw !== null || this.preview) && ["Escape", "Enter", "PageDown", "PageUp", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { this.consume(event); this.c.interrupt?.("Manual keyboard control selected; automatic task stopped."); return; }
    if (!this.contact) { if (event.key === "Enter" && this.enabled) { this.consume(event); this.engageSelected(); } return; }
    const amount = event.shiftKey ? .5 : 2;
    if (["Escape", "Enter", "PageDown", "PageUp", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) this.consume(event); else return;
    if (event.key === "Escape" || event.key === "Enter") this.release();
    else if (event.key === "PageDown") this.adjustDepth(amount);
    else if (event.key === "PageUp") this.adjustDepth(-amount);
    else this.moveLateral(event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0, event.key === "ArrowUp" ? amount : event.key === "ArrowDown" ? -amount : 0);
  };
  tick(now: number, delta: number) {
    if (this.disposed) return;
    const o = this.c.options();
    if (this.preview) {
      if (!this.enabled || o.mode !== "grasp") { this.release("Automatic approach interrupted by scene settings."); return; }
      const { plan, point } = this.preview;
      this.poseOrigin.copy(point); this.tipCenter.copy(point); this.visualTip.copy(point); this.lastAxis.fromArray(plan.axis); this.lastNormal.fromArray(plan.contact.normal);
      this.grasper.group.position.copy(point); this.grasper.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.lastAxis);
      this.grasper.setJawClosure(this.jawClosure); this.grasper.group.visible = true; this.probe.group.visible = false; this.c.controls.enabled = false;
      this.requestedMarker.visible = this.targetLine.visible = false;
      if (now - this.lastStatus > 100) this.publish(true);
      return;
    }
    if (this.contact && (!this.enabled || !this.contact.anchor.part.mesh.visible || o.mode !== this.contact.mode)) this.release("Instrument released after scene settings changed.");
    // Advance the existing displacement-controlled contact even when the pointer
    // stays still. Every increment uses the same finite instrument sweep and
    // depth bound as a manual push; the solver still determines reaction force.
    if (this.holdingPush && Number.isFinite(delta) && delta > 0) {
      const speed = Number.isFinite(o.pushSpeedMmS) ? THREE.MathUtils.clamp(o.pushSpeedMmS!, .5, 5) : 3;
      if (this.contact!.depth < 20) this.adjustDepth(speed * Math.min(delta, .1), false);
      if (!this.guard.blocked) this.message = this.contact!.depth >= 20
        ? "Push depth limit reached (20 mm). Release the button to let the tissue recover."
        : "Continuously pushing. Keep holding to press deeper; release the button to stop.";
    }
    this.c.controls.enabled = !this.contact && o.recording !== "interaction";
    const anchor = this.contact?.anchor ?? null;
    const previousJaw = this.jawClosure; this.jawClosure = this.automaticJaw ?? THREE.MathUtils.damp(this.jawClosure, this.contact?.mode === "grasp" ? 1 : 0, 20, delta);
    if (Math.abs(previousJaw - this.jawClosure) > .0001) this.c.invalidate(true);
    this.grasper.setJawClosure(this.jawClosure);
    this.probe.group.visible = Boolean(anchor && o.mode === "push"); this.grasper.group.visible = Boolean(anchor && o.mode === "grasp");
    if (anchor) {
      const point = this.renderedPoint(anchor), normal = this.contact?.mode === "push" ? this.contact.normal.clone() : this.displayedNormal(anchor), axis = this.contact?.axis ?? this.approachAxis(normal);
      this.lastNormal.copy(normal); this.lastAxis.copy(axis); this.visualTip.copy(point);
      const separation = this.contact?.mode === "push" ? Math.max(0, this.contact.target.clone().sub(point).dot(normal)) : 0;
      this.visualTip.addScaledVector(normal, separation);
      this.tipCenter.copy(this.visualTip).addScaledVector(normal, o.mode === "push" ? o.radius : 0);
      this.poseOrigin.copy(o.mode === "push" ? this.tipCenter.clone().addScaledVector(axis, -o.radius) : point);
      const instrument = o.mode === "push" ? this.probe : this.grasper;
      instrument.group.position.copy(this.poseOrigin); instrument.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
      if (this.contact) {
        const selectedSurface = this.partSurface(anchor.part);
        let nearest = selectedSurface.closestPoint(array(this.tipCenter));
        if (o.mode === "push") {
          for (let correction = 0; nearest && nearest.distanceMm < o.radius - .002 && correction < 5; correction++) {
            // Small conservative clearance correction; its actual gap to the
            // triangle attachment remains measurable in the exported witnesses.
            const amount = Math.min(2, (o.radius - nearest.distanceMm + .003) / Math.max(.25, normal.dot(vec(nearest.normal))));
            this.tipCenter.addScaledVector(normal, amount); this.visualTip.addScaledVector(normal, amount);
            nearest = selectedSurface.closestPoint(array(this.tipCenter));
          }
          this.poseOrigin.copy(this.tipCenter).addScaledVector(axis, -o.radius); instrument.group.position.copy(this.poseOrigin);
        }
        this.geometricClearance = o.mode === "push" && nearest ? nearest.distanceMm - o.radius : 0;
        this.measuredPenetration = Math.max(0, -this.geometricClearance);
        if (o.mode === "push" && this.measuredPenetration > .05) {
          this.guard = { blocked: true, organId: anchor.organId, kind: "tip", clearanceMm: this.geometricClearance, time: 0, reason: "The finite tip cannot clear this fold after bounded outward projection.", conservative: false };
          this.release("The finite tip cannot clear this fold; choose a smaller probe radius or another approach."); return;
        }
      }
      // Recheck the displayed pose against current uploaded geometry, including
      // tissue motion while the pointer is stationary. Unsafe proxies disappear
      // before rendering; requested-target sweeps alone cannot provide this guard.
      if (this.contact && (this.guardRevision !== this.revision || Math.abs(this.lastGuardJaw - this.jawClosure) > .03)) {
        this.guardRevision = this.revision; this.lastGuardJaw = this.jawClosure;
        const actualGuard = this.collision(this.visualTip, this.visualTip, normal, axis, anchor.part, true, anchor);
        if (actualGuard.blocked) { this.guard = actualGuard; this.release(`Current instrument approach meets ${actualGuard.organId} (${actualGuard.kind}); contact released.`); return; }
      }
      this.requestedMarker.visible = this.targetLine.visible = Boolean(this.contact && this.contact.target.distanceTo(point) > .25);
      if (this.contact) {
        this.requestedMarker.material.color.setHex(0xefb96c);
        this.requestedMarker.position.copy(this.contact.target);
        const positions = this.targetLine.geometry.getAttribute("position") as THREE.BufferAttribute;
        positions.setXYZ(0, point.x, point.y, point.z); positions.setXYZ(1, this.contact.target.x, this.contact.target.y, this.contact.target.z); positions.needsUpdate = true; this.targetLine.geometry.computeBoundingSphere();
      }
    } else {
      // Hover is only a surface cursor. A complete rigid instrument is shown
      // after its approach has passed the geometric guards.
      this.targetLine.visible = false;
      this.requestedMarker.visible = Boolean(this.enabled && this.hover);
      if (this.hover) { this.requestedMarker.position.copy(this.renderedPoint(this.hover)); this.requestedMarker.material.color.setHex(this.guard.blocked ? 0xe69476 : 0x8bd8bf); }
    }
    this.publish(now - this.lastStatus >= 150);
  }
  private state(): WholeSceneToolState {
    const o = this.c.options(), solver = this.c.physics()?.toolSnapshot();
    return { mode: o.mode, ready: this.available, active: Boolean(this.contact), organId: this.contact?.anchor.organId ?? null, depthMm: this.contact?.depth ?? o.depth, radiusMm: o.radius,
      continuousPush: Boolean(o.continuousPush), holdingPush: this.holdingPush,
      targetMm: this.contact ? array(this.contact.target) : null, contactPointMm: this.contact ? array(this.renderedPoint(this.contact.anchor)) : null,
      reactionN: this.contact && solver ? Math.hypot(...solver.forceN) : 0, penetrationMm: this.contact ? this.measuredPenetration : 0, slipMm: this.contact && solver ? solver.residualMm : 0, message: this.message };
  }
  private publish(force: boolean) { if (!force || this.disposed) return; this.lastStatus = performance.now(); this.c.status(this.state()); }
  private pickCandidates(organId?: string) {
    const o = { ...this.c.options(), selected: organId ?? this.c.options().selected }; if (!this.enabled || !o.selected || this.contact) return this.candidates;
    const stamp = `${o.selected}:${this.c.camera.position.toArray().map(v => v.toFixed(1))}:${this.c.controls.target.toArray().map(v => v.toFixed(1))}:${this.c.parts().filter(p => p.mesh.visible).map(p => p.info.id).join()}`;
    if (stamp === this.candidateStamp && performance.now() - this.candidateTime < 1200) return this.candidates;
    this.candidateStamp = stamp; this.candidateTime = performance.now(); this.candidates = [];
    const part = this.c.parts().find(p => p.info.id === o.selected && p.mesh.visible); if (!part) return this.candidates;
    const p = part.mesh.geometry.getAttribute("position"), index = part.mesh.geometry.index, count = (index?.count ?? p.count) / 3;
    const rect = this.c.canvas.getBoundingClientRect(), proposed: { point: THREE.Vector3; distance: number }[] = [];
    const center = part.mesh.geometry.boundingBox!.getCenter(new THREE.Vector3()).project(this.c.camera);
    for (let f = 0; f < count; f += Math.max(1, Math.floor(count / 512))) {
      const point = new THREE.Vector3(); for (let k = 0; k < 3; k++) point.add(new THREE.Vector3().fromBufferAttribute(p, index ? index.getX(f * 3 + k) : f * 3 + k)); point.multiplyScalar(1 / 3).project(this.c.camera);
      if (Math.abs(point.x) < .96 && Math.abs(point.y) < .96 && point.z > -1 && point.z < 1) proposed.push({ point, distance: (point.x - center.x) ** 2 + (point.y - center.y) ** 2 });
    }
    proposed.sort((a, b) => a.distance - b.distance);
    // Prefer exposed interior patches; extreme silhouette points often cannot admit a finite probe.
    const ordered = proposed;
    for (const candidate of ordered.slice(0, 180)) {
      const x = (candidate.point.x + 1) * .5 * rect.width, y = (1 - candidate.point.y) * .5 * rect.height;
      const hit = this.pick(rect.left + x, rect.top + y); if (!hit || hit.organId !== part.info.id) continue;
      if (this.candidates.some(c => c.faceIndex === hit.triangleIndex || Math.hypot(Number(c.canvasX) - x, Number(c.canvasY) - y) < 24)) continue;
      this.candidates.push({ organId: hit.organId, faceIndex: hit.triangleIndex, clientX: rect.left + x, clientY: rect.top + y, canvasX: x, canvasY: y, pointMm: hit.pointMm, barycentric: hit.barycentric, triangleMm: this.triangle(hit), surfaceRevision: this.revision, generatedAtMs: this.candidateTime });
      if (this.candidates.length >= (organId ? 18 : 8)) break;
    }
    return this.candidates;
  }
  snapshot() {
    const o = this.c.options(), anchor = this.contact?.anchor ?? (this.preview ? this.automaticAnchor : this.lastAnchor), solver = this.c.physics()?.toolSnapshot();
    const point = anchor ? this.renderedPoint(anchor) : null;
    const cameraClearance = (this.contact || this.preview) && (this.probe.group.visible || this.grasper.group.visible) ? cameraInstrumentClearance(this.c.camera.position,this.poseOrigin,this.poseOrigin,this.lastAxis,o.mode === "push" ? "push" : "grasp",o.radius,this.jawClosure) : null;
    return { ...this.state(), available: this.available, enabled: this.enabled, engaged: Boolean(this.contact), latched: this.contact?.latched ?? false, phase: this.contact ? "contact" : this.guard.blocked ? "blocked" : this.hover ? "hover" : "idle",
      organId: anchor?.organId ?? null, faceIndex: anchor?.triangleIndex ?? null, vertexIndices: anchor?.vertexIndices ?? null, barycentric: anchor?.barycentric ?? null,
      restTriangleMm: anchor ? anchor.vertexIndices.map(i => vertex(anchor.part.variant, i)) : null, surfaceTriangleMm: anchor ? this.triangle(anchor) : null,
      surfacePointMm: point?.toArray() ?? null, solverActualSurfacePointMm: solver?.actualSurfacePointMm ?? null, solverUploadGapMm: point && solver ? point.distanceTo(vec(solver.actualSurfacePointMm)) : 0,
      normal: this.lastNormal.toArray(), displayedTriangleNormal: anchor ? this.displayedNormal(anchor).toArray() : null, normalPolicy: "Pressure normal is held during a push and refreshed when its footprint slides; grasper position follows its triangle attachment.", axis: this.lastAxis.toArray(), requestedTargetMm: this.contact?.target.toArray() ?? null,
      tipCenterMm: this.tipCenter.toArray(), poseOriginMm: this.poseOrigin.toArray(), visualTipMm: this.visualTip.toArray(), instrumentKind: o.mode === "push" ? "probe" : o.mode === "grasp" ? "grasper" : null,
      cameraClearanceMm: cameraClearance?.clearanceMm ?? null, cameraGuardRadiusMm: CAMERA_GUARD_RADIUS_MM, cameraClearanceKind: cameraClearance?.kind ?? null,
      physicsContactRadiusMm: o.mode === "grasp" ? 3 : o.radius, collisionEnvelope: { version: "articulated-metal-capsules-v2", probeSphereRadiusMm: o.mode === "push" ? o.radius : null, capsules: instrumentContactEnvelopes(o.mode === "push" ? "push" : "grasp", o.radius, this.jawClosure).map(envelope => ({ ...envelope, worldStartMm: vec(envelope.startMm).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.lastAxis)).add(this.poseOrigin).toArray(), worldEndMm: vec(envelope.endMm).applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.lastAxis)).add(this.poseOrigin).toArray() })) }, instrumentVisible: this.probe.group.visible || this.grasper.group.visible, jawClosure: this.jawClosure, pointerCaptured: this.contact?.pointer !== null && this.contact?.pointer !== undefined ? this.c.canvas.hasPointerCapture(this.contact.pointer) : false, cameraLocked: !this.c.controls.enabled,
      geometricClearanceMm: this.geometricClearance, visualTipAnchorGapMm: point ? this.visualTip.distanceTo(point) : 0, selectedDistalPatchTriangles: this.currentPatchSize, guard: this.guard, solver, surfaceRevision: this.revision,
      pickCandidates: this.pickCandidates(), accelerationStructures: [...this.cache.values()].map(c => c.surface.snapshot()),
      limitations: "Conservative full-instrument camera clearance; finite spherical probe and closure-dependent conservative jaw/5 mm shaft capsules; connected local attachment patch excluded from distal guards; no handle-to-tissue collision, tissue cutting, tearing, frictional slip, or organ-organ contact. Force response uses synthetic learned material priors.",
    };
  }
  dispose() {
    this.disposed = true; this.release();
    const canvas = this.c.canvas;
    canvas.removeEventListener("pointerdown", this.onDown, true); canvas.removeEventListener("pointermove", this.onMove, true); canvas.removeEventListener("pointerup", this.onUp, true);
    canvas.removeEventListener("pointercancel", this.onCancel, true); canvas.removeEventListener("lostpointercapture", this.onLost, true); canvas.removeEventListener("pointerleave", this.onLeave);
    canvas.removeEventListener("wheel", this.onWheel, true); canvas.removeEventListener("keydown", this.onKey); window.removeEventListener("blur", this.onBlur);
    this.c.scene.remove(this.probe.group, this.grasper.group, this.requestedMarker, this.targetLine);
    this.probe.dispose(); this.grasper.dispose(); this.requestedMarker.geometry.dispose(); this.requestedMarker.material.dispose(); this.targetLine.geometry.dispose(); this.targetLine.material.dispose(); this.cache.clear();
  }
}
