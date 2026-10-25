import * as THREE from "three";
import type { WholeScenePhysics } from "./wholeScenePhysics";
import type { WholeSceneTools, AutomaticGraspPlan } from "./wholeSceneTools";
import { GRASP_PROFILES, GRASP_LIMITS, smoothGrasp, graspViolation, type GraspPolicy, type GraspTrainingInput } from "./graspPolicy";

export type AutomaticGraspPhase = "idle" | "settling" | "planning" | "learning" | "approaching" | "checking" | "contacting" | "closing" | "lifting" | "holding" | "lowering" | "opening" | "withdrawing" | "recovering" | "complete" | "stopped" | "blocked";
export interface AutomaticGraspState {
  policyStatus: "idle" | "validating" | "learning" | "ready";
  timing: { startMs: number; planMs: number; policyMs: number; motionDelayMs: number | null; contactDelayMs: number | null; source: "pending" | "saved-revalidated" | "learned" | "cache" };
  phase: AutomaticGraspPhase; message: string; elapsedSeconds: number; progress: number; total: number;
  forceN: number; peakForceN: number; displacementMm: number; peakDisplacementMm: number; peakGradient: number;
  targetOffsetMm: number; holdDisplacementMm: number; recoveryMm: number; succeeded: boolean;
  policy: GraspPolicy | null; plan: AutomaticGraspPlan | null; limits: typeof GRASP_LIMITS;
  trainingInput: GraspTrainingInput | null;
  frames: { time: number; phase: AutomaticGraspPhase; forceN: number; displacementMm: number; targetOffsetMm: number; tipMm: number[] | null }[];
}
interface Context {
  tools: WholeSceneTools; camera: THREE.PerspectiveCamera; physics: () => WholeScenePhysics | null;
  trainingInput: (plan: AutomaticGraspPlan) => GraspTrainingInput;
  lensClear?: () => boolean;
  publish: (state: AutomaticGraspState) => void;
}
const initial = (): AutomaticGraspState => ({ policyStatus: "idle", timing: { startMs: 0, planMs: 0, policyMs: 0, motionDelayMs: null, contactDelayMs: null, source: "pending" }, phase: "idle", message: "", elapsedSeconds: 0, progress: 0, total: 17, forceN: 0, peakForceN: 0, displacementMm: 0, peakDisplacementMm: 0, peakGradient: 0, targetOffsetMm: 0, holdDisplacementMm: 0, recoveryMm: 0, succeeded: false, policy: null, plan: null, trainingInput: null, limits: GRASP_LIMITS, frames: [] });
const labels: Partial<Record<AutomaticGraspPhase, string>> = { settling: "Waiting for tissue recovery", planning: "Checking exposed liver patches and instrument clearance", learning: "Learning a bounded grasp option in isolated physics rollouts", approaching: "Approaching the exposed liver patch; checking tissue response", checking: "Holding clear of tissue until the grasp checks pass", contacting: "Grasp checks passed; completing the approach", closing: "Closing the jaws gradually", lifting: "Applying a controlled tissue lift", holding: "Holding and observing tissue response", lowering: "Returning the tissue gradually", opening: "Opening the jaws", withdrawing: "Withdrawing along the checked approach", recovering: "Checking tissue recovery", complete: "Liver grasp completed; tissue released and recovered" };

/** Authored option supervisor: learned camera arrives first; this controller
 * revalidates a learned option during a guarded no-contact approach, then checks the coupled response each
 * frame. It is not an end-to-end visual or clinically calibrated robot policy. */
export class AutomaticGrasp {
  private readonly policyCache = new Map<string, GraspPolicy>();
  private waitForRelease = false; private releaseRequested = false;
  private state = initial(); private phaseTime = 0; private lastPublish = 0;
  private controller: AbortController | null = null; private worker: Worker | null = null;
  private finish: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private cameraPosition = new THREE.Vector3(); private cameraRotation = new THREE.Quaternion();
  constructor(private readonly c: Context) {}
  get active() { return !["idle", "complete", "stopped", "blocked"].includes(this.state.phase); }
  snapshot(): AutomaticGraspState { return { ...this.state, timing: { ...this.state.timing }, frames: this.state.frames.slice() }; }
  private publish() { this.c.publish(this.snapshot()); }
  private stage(phase: AutomaticGraspPhase) { this.state.phase = phase; this.state.message = labels[phase] ?? phase; this.phaseTime = 0; this.publish(); }
  stop(message = "Automatic task stopped; instrument released.", blocked = false) {
    if (!this.active) return;
    this.controller?.abort(); this.worker?.terminate(); this.worker = null;
    this.state.phase = blocked ? "blocked" : "stopped"; this.state.message = message;
    this.c.tools.release(message, true); this.finish?.reject(new Error(message)); this.finish = null; this.publish();
  }
  requestRelease() {
    if (!this.active || this.state.phase !== "holding" || !this.waitForRelease) throw new Error("The automatic grasper is not awaiting release.");
    this.releaseRequested = true;
  }
  async start(signal: AbortSignal, seed = 42, waitForRelease = false) {
    if (this.active) throw new Error("Stop the current grasp task first.");
    if (signal.aborted || !this.c.tools.enabled || !this.c.physics()) throw new Error("The grasp task is not ready.");
    this.state = initial(); this.state.timing.startMs = performance.now(); this.lastPublish = 0; this.controller = new AbortController();
    this.waitForRelease = waitForRelease; this.releaseRequested = false;
    const local = this.controller.signal, abort = () => this.stop("Automatic task cancelled; instrument released.");
    signal.addEventListener("abort", abort, { once: true });
    this.cameraPosition.copy(this.c.camera.position); this.cameraRotation.copy(this.c.camera.quaternion);
    try {
      this.stage("settling");
      const deadline = performance.now() + 8000;
      while (this.c.physics()!.snapshot().displacement_mm > .05) {
        local.throwIfAborted(); if (performance.now() > deadline) throw new Error("Tissue is still moving. Let it recover before trying a new grasp task.");
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      local.throwIfAborted(); this.stage("planning");
      const planningBegan = performance.now();
      const plan = await this.c.tools.planAutomaticGrasp("liver", local); local.throwIfAborted(); this.state.plan = plan;
      this.state.timing.planMs = performance.now() - planningBegan;
      const input = this.c.trainingInput(plan); this.state.trainingInput = structuredClone(input);
      // Cache only identical solver inputs, including the contact triangle,
      // materials, attachment graph and authored responses. Geometry and the
      // entire instrument sweep are checked freshly above on every execution.
      const key = JSON.stringify([input, seed]), cached = this.policyCache.get(key);
      const policyBegan = performance.now(); this.state.policyStatus = "validating"; this.state.total = cached ? 0 : 3;
      const motion = new Promise<void>((resolve, reject) => { this.finish = { resolve, reject }; });
      const learning = (cached ? Promise.resolve(structuredClone(cached)) : new Promise<GraspPolicy>((resolve, reject) => {
        const worker = new Worker(new URL("./graspPolicy.worker.ts", import.meta.url), { type: "module" }); this.worker = worker;
        const timeout = setTimeout(() => done(new Error("Grasp checks timed out. No tissue was grasped.")), 90000);
        const cancelled = () => done(new DOMException("Grasp checks cancelled.", "AbortError"));
        let finished = false;
        const done = (error?: Error, value?: GraspPolicy) => { if (finished) return; finished = true; clearTimeout(timeout); local.removeEventListener("abort", cancelled); worker.terminate(); if (this.worker === worker) this.worker = null; if (error) reject(error); else resolve(value!); };
        local.addEventListener("abort", cancelled, { once: true });
        worker.onerror = event => done(new Error(event.message || "The grasp worker failed."));
        worker.onmessage = event => {
          if (event.data.type === "progress") { this.state.progress = event.data.done; this.state.total = event.data.total; this.publish(); }
          else if (event.data.type === "learning") { this.state.policyStatus = "learning"; this.state.progress = 0; this.state.total = 17; this.publish(); }
          else if (event.data.type === "error") done(new Error(event.data.message));
          else if (event.data.type === "complete") done(undefined, event.data.policy as GraspPolicy);
        };
        worker.postMessage({ input, seed });
      })).then(policy => {
        local.throwIfAborted();
        if (!GRASP_PROFILES[policy.action] || policy.evaluation.length !== 3 || !policy.evaluation.every((e, i) => e.success && e.action === policy.action && e.stiffnessScale === [.8, 1, 1.2][i])) throw new Error("Grasp policy failed execution checks.");
        this.state.policy = policy; this.state.policyStatus = "ready";
        this.state.timing.policyMs = performance.now() - policyBegan;
        this.state.timing.source = cached ? "cache" : policy.revalidation ? "saved-revalidated" : "learned";
        if (!cached) { if (this.policyCache.size >= 4) this.policyCache.delete(this.policyCache.keys().next().value!); this.policyCache.set(key, structuredClone(policy)); }
        this.publish();
      });
      // Observe both promises immediately, including cancellation and worker
      // errors while the no-contact approach is already running.
      const completed = Promise.all([learning, motion]);
      try {
        this.c.tools.previewAutomaticGrasp(plan, plan.startOffsetMm);
        this.state.timing.motionDelayMs = performance.now() - this.state.timing.startMs;
        this.stage("approaching");
      } catch (error) { this.stop(error instanceof Error ? error.message : "Grasper approach blocked.", true); }
      await completed;
      return this.snapshot();
    } catch (error) {
      if (this.active) this.stop(error instanceof Error ? error.message : "Automatic grasp failed.", true);
      throw error;
    } finally { signal.removeEventListener("abort", abort); this.worker?.terminate(); this.worker = null; this.controller = null; }
  }
  tick(delta: number) {
    if (!this.active) return;
    if (!this.c.tools.enabled || !this.c.physics()) { this.stop("Physics or instrument mode changed; task stopped."); return; }
    if (this.c.lensClear && !this.c.lensClear()) { this.stop("Tissue entered the lens-clearance boundary; instrument released.", true); return; }
    if (this.c.camera.position.distanceTo(this.cameraPosition) > .01 || this.c.camera.quaternion.angleTo(this.cameraRotation) > 1e-4) { this.stop("Camera moved; automatic instrument control stopped."); return; }
    const dt = Math.min(.05, Math.max(0, delta)); this.state.elapsedSeconds += dt; this.phaseTime += dt;
    const phase = this.state.phase, plan = this.state.plan, policy = this.state.policy;
    if (!plan || ["settling", "planning", "learning"].includes(phase)) return;
    const p = policy ? GRASP_PROFILES[policy.action]! : null;
    const standOffMm = 2, approachSeconds = (plan.startOffsetMm - standOffMm) * 1.875 / 12;
    const contactSeconds = standOffMm * 1.875 / 12, withdrawSeconds = plan.startOffsetMm * 1.875 / 12;
    const physics = this.c.physics()!.snapshot(), tool = physics.tool;
    this.state.forceN = tool?.active ? Math.hypot(...tool.forceN) : 0; this.state.displacementMm = physics.displacement_mm;
    this.state.peakForceN = Math.max(this.state.peakForceN, this.state.forceN); this.state.peakDisplacementMm = Math.max(this.state.peakDisplacementMm, physics.displacement_mm); this.state.peakGradient = Math.max(this.state.peakGradient, physics.displacement_gradient_bound);
    const violation = graspViolation({ forceN: this.state.forceN, displacementMm: physics.displacement_mm, gradient: physics.displacement_gradient_bound, residualMm: tool?.active ? tool.residualMm : 0, finite: physics.finite, clamped: Boolean(tool?.active && tool.clamped) });
    if (violation) { this.stop(`${violation}; instrument released.`, true); return; }
    try {
      if (phase === "approaching") {
        this.c.tools.previewAutomaticGrasp(plan, standOffMm + (plan.startOffsetMm - standOffMm) * (1 - smoothGrasp(this.phaseTime / approachSeconds)));
        if (this.phaseTime >= approachSeconds) this.stage(policy ? "contacting" : "checking");
      } else if (phase === "checking") {
        // The instrument remains outside tissue until current-scene solver
        // validation finishes. Neither training nor inference may bypass this.
        if (policy) this.stage("contacting");
      } else if (phase === "contacting") {
        if (!policy) throw new Error("Grasp policy was lost before contact.");
        this.c.tools.previewAutomaticGrasp(plan, standOffMm * (1 - smoothGrasp(this.phaseTime / contactSeconds)));
        if (this.phaseTime >= contactSeconds) {
          this.c.tools.attachAutomaticGrasp(plan);
          this.state.timing.contactDelayMs = performance.now() - this.state.timing.startMs;
          this.stage("closing");
        }
      } else if (phase === "closing") {
        this.c.tools.commandAutomaticGrasp(0, smoothGrasp(this.phaseTime / 1.2));
        if (this.phaseTime >= 1.2) this.stage("lifting");
      } else if (["lifting", "holding", "lowering"].includes(phase)) {
        if (!p) throw new Error("Grasp policy was lost during contact.");
        const offset = phase === "lifting" ? p.liftMm * smoothGrasp(this.phaseTime / p.rampSeconds) : phase === "holding" ? p.liftMm : p.liftMm * (1 - smoothGrasp(this.phaseTime / p.rampSeconds));
        this.state.targetOffsetMm = offset; this.c.tools.commandAutomaticGrasp(offset, 1);
        if (phase === "holding") this.state.holdDisplacementMm = Math.max(this.state.holdDisplacementMm, Math.hypot(...(tool?.displacementMm ?? [0])));
        if (phase === "holding" && this.waitForRelease && this.phaseTime > 15) throw new Error("Release decision timed out");
        const mayAdvance = phase !== "holding" || !this.waitForRelease || this.releaseRequested;
        if (mayAdvance && this.phaseTime >= (phase === "holding" ? p.holdSeconds : p.rampSeconds)) this.stage(phase === "lifting" ? "holding" : phase === "holding" ? "lowering" : "opening");
      } else if (phase === "opening") {
        this.state.targetOffsetMm = 0; this.c.tools.commandAutomaticGrasp(0, 1 - smoothGrasp(this.phaseTime / 1));
        if (this.phaseTime >= 1) { this.c.tools.detachAutomaticGrasp(); this.stage("withdrawing"); }
      } else if (phase === "withdrawing") {
        this.c.tools.previewAutomaticGrasp(plan, plan.startOffsetMm * smoothGrasp(this.phaseTime / withdrawSeconds));
        if (this.phaseTime >= withdrawSeconds) { this.c.tools.release("Grasper withdrawn; observing recovery.", true); this.stage("recovering"); }
      } else if (phase === "recovering" && this.phaseTime >= 1.5) {
        this.state.recoveryMm = physics.displacement_mm;
        if (this.state.holdDisplacementMm < .5 || physics.displacement_mm > .2) throw new Error("The grasp did not meet hold and recovery criteria.");
        this.state.succeeded = true; this.stage("complete"); this.finish?.resolve(); this.finish = null;
      }
      if (this.state.elapsedSeconds - this.lastPublish >= .1) {
        this.lastPublish = this.state.elapsedSeconds;
        if (this.state.frames.length < 1200) this.state.frames.push({ time: this.state.elapsedSeconds, phase, forceN: this.state.forceN, displacementMm: physics.displacement_mm, targetOffsetMm: this.state.targetOffsetMm, tipMm: tool?.actualSurfacePointMm ?? null });
        this.publish();
      }
    } catch (error) { this.stop(error instanceof Error ? error.message : "Grasp motion blocked.", true); }
  }
  dispose() { this.stop("Viewer closed; automatic task cancelled."); }
}
