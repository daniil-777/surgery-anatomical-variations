import { WholeScenePhysics, type LearnedSceneMaterials, type ScenePhysicsOrgan, type ScenePhysicsAttachment, type SceneToolContactInput } from "./wholeScenePhysics";
import type { SceneTissueResponse } from "./sceneTissueResponse";

/** Simulation budgets, not clinical tissue-damage or jaw-pressure thresholds. */
export const GRASP_LIMITS = Object.freeze({ forceN: .8, displacementMm: 5, gradient: .35, residualMm: 2, liftMm: 4, targetSpeedMmS: 3 });
export const GRASP_PROFILES = Object.freeze([
  { liftMm: 2, rampSeconds: 2.5, holdSeconds: 1.5 },
  { liftMm: 3, rampSeconds: 3, holdSeconds: 1.5 },
  { liftMm: 4, rampSeconds: 4, holdSeconds: 1.5 },
]);
export interface GraspTrainingInput {
  organs: ScenePhysicsOrgan[]; materials: LearnedSceneMaterials;
  responses: Record<string, SceneTissueResponse>; attachments: ScenePhysicsAttachment[];
  contact: SceneToolContactInput;
}
export interface GraspTrial {
  action: number; stiffnessScale: number; reward: number; success: boolean;
  peakForceN: number; peakDisplacementMm: number; peakGradient: number;
  holdDisplacementMm: number; recoveryMm: number; peakResidualMm: number; finite: boolean;
}
export interface GraspPolicy {
  version: "viscera.grasp-bandit/1"; seed: number; episodes: number; q: number[]; visits: number[]; action: number;
  trials: GraspTrial[]; evaluation: GraspTrial[]; trainingMs: number;
  baseline: { nominalByAction: GraspTrial[]; selectedReward: number; uniformReward: number };
  modelId: string; scope: string;
}
export const smoothGrasp = (t: number) => { const x = Math.max(0, Math.min(1, t)); return Math.max(0, Math.min(1, x * x * x * (10 + x * (-15 + 6 * x)))); };
export function graspOffset(action: number, time: number) {
  const p = GRASP_PROFILES[action]; if (!p) throw new Error("Unsupported grasp action.");
  if (time < p.rampSeconds) return p.liftMm * smoothGrasp(time / p.rampSeconds);
  if (time < p.rampSeconds + p.holdSeconds) return p.liftMm;
  return p.liftMm * (1 - smoothGrasp((time - p.rampSeconds - p.holdSeconds) / p.rampSeconds));
}
export function graspViolation(s: { forceN: number; displacementMm: number; gradient: number; residualMm: number; finite: boolean; clamped: boolean }) {
  if (!s.finite || ![s.forceN, s.displacementMm, s.gradient, s.residualMm].every(Number.isFinite)) return "Non-finite tissue response";
  if (s.forceN > GRASP_LIMITS.forceN) return "Reaction-force budget exceeded";
  if (s.displacementMm > GRASP_LIMITS.displacementMm) return "Tissue-displacement budget exceeded";
  if (s.gradient > GRASP_LIMITS.gradient || s.clamped) return "Tissue-strain budget exceeded";
  if (s.residualMm > GRASP_LIMITS.residualMm) return "Grasp attachment lag exceeded";
  return null;
}

/** Each episode is a real rollout of the same coupled SLS solver used on screen.
 * The one-step policy selects a bounded trajectory option; it does not learn
 * pixel perception, contact locations, jaw pressure, or the task supervisor. */
export function evaluateGrasp(input: GraspTrainingInput, action: number, stiffnessScale = 1): GraspTrial {
  const profile = GRASP_PROFILES[action];
  if (!profile || !Number.isFinite(stiffnessScale) || stiffnessScale < .7 || stiffnessScale > 1.3 || input.contact.mode !== "grasp" || input.contact.organId !== "liver") throw new Error("Unsupported grasp training input.");
  const materials = { ...input.materials, materials: input.materials.materials.map(m => ({ ...m, young_pa: Math.max(500, Math.min(20000, m.young_pa * stiffnessScale)) })) };
  const solver = new WholeScenePhysics(input.organs, materials, input.responses, input.attachments);
  solver.beginToolContact(input.contact);
  const out: GraspTrial = { action, stiffnessScale, reward: 0, success: true, peakForceN: 0, peakDisplacementMm: 0, peakGradient: 0, holdDisplacementMm: 0, recoveryMm: 0, peakResidualMm: 0, finite: true };
  const duration = profile.rampSeconds * 2 + profile.holdSeconds;
  for (let frame = 1; frame <= Math.ceil((duration + 1.5) * 30); frame++) {
    const time = frame / 30;
    if (time <= duration) solver.moveToolTarget(input.contact.targetPointMm.map((v, a) => v + input.contact.normal[a]! * graspOffset(action, time)));
    else solver.releaseToolContact();
    solver.step(1 / 30, false);
    const state = solver.snapshot(), contact = state.tool!;
    const force = Math.hypot(...contact.forceN);
    out.peakForceN = Math.max(out.peakForceN, force); out.peakDisplacementMm = Math.max(out.peakDisplacementMm, state.displacement_mm);
    out.peakGradient = Math.max(out.peakGradient, state.displacement_gradient_bound); out.finite &&= state.finite;
    out.peakResidualMm = Math.max(out.peakResidualMm, contact.residualMm);
    if (time >= profile.rampSeconds && time <= profile.rampSeconds + profile.holdSeconds) out.holdDisplacementMm = Math.max(out.holdDisplacementMm, Math.hypot(...contact.displacementMm));
    if (graspViolation({ forceN: force, displacementMm: state.displacement_mm, gradient: state.displacement_gradient_bound, residualMm: contact.active ? contact.residualMm : 0, finite: state.finite, clamped: contact.clamped })) out.success = false;
    out.recoveryMm = state.displacement_mm;
  }
  out.success &&= out.holdDisplacementMm >= .5 && out.recoveryMm < .2;
  out.reward = out.success ? 5 - Math.abs(out.holdDisplacementMm - 1.5) - 2 * out.peakForceN - .025 * duration : -5;
  return out;
}
export function trainGraspPolicy(input: GraspTrainingInput, seed = 42, progress?: (done: number, total: number) => void): GraspPolicy {
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new Error("Invalid grasp training seed.");
  const began = performance.now(), q = [0, 0, 0], visits = [0, 0, 0], trials: GraspTrial[] = [];
  let rng = seed >>> 0;
  const random = () => { rng = (Math.imul(1664525, rng) + 1013904223) >>> 0; return rng / 4294967296; };
  // UCB explores each option, then spends remaining rollouts on promising ones.
  // Bounded 12-episode budget; no replayed synthetic "episode count" inflation.
  for (let episode = 0; episode < 12; episode++) {
    const scores = q.map((value, a) => visits[a] ? value + 1.2 * Math.sqrt(Math.log(episode + 1) / visits[a]!) : Infinity);
    const action = scores.indexOf(Math.max(...scores));
    const trial = evaluateGrasp(input, action, .85 + random() * .3); trials.push(trial);
    visits[action]!++; q[action]! += (trial.reward - q[action]!) / visits[action]!; progress?.(episode + 1, 17);
  }
  const action = q.indexOf(Math.max(...q));
  // Frozen-policy checks use stiffness values outside the training interval,
  // plus nominal parameters. They are local robustness, not patient validation.
  const evaluation = [.8, 1, 1.2].map((scale, i) => { const result = evaluateGrasp(input, action, scale); progress?.(13 + i, 17); return result; });
  if (!evaluation.every(e => e.success)) throw new Error("No grasp option passed the local physics checks. No tool motion was started.");
  let checks = 15;
  const nominalByAction = GRASP_PROFILES.map((_, candidate) => { if (candidate === action) return evaluation[1]!; const trial = evaluateGrasp(input, candidate); progress?.(++checks, 17); return trial; });
  const baseline = { nominalByAction, selectedReward: evaluation[1]!.reward, uniformReward: nominalByAction.reduce((sum, trial) => sum + trial.reward, 0) / nominalByAction.length };
  if (baseline.selectedReward < baseline.uniformReward) throw new Error("The learned grasp option did not outperform the uniform-option baseline.");
  return { version: "viscera.grasp-bandit/1", seed, episodes: trials.length, q, visits, action, trials, evaluation, baseline, trainingMs: performance.now() - began, modelId: input.materials.model_id,
    scope: "UCB episodic option selection on the current coupled synthetic-material solver; geometric contact selection and stage supervision are authored; no clinical or visual-policy generalization." };
}
