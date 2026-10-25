/** Versioned option-action interface. The model selects skills; it never writes
 * camera poses, collision geometry, tissue parameters, or guard limits. */
export const VISUAL_SKILLS = ["look", "grasp", "release", "finish", "wait"] as const;
export type VisualSkill = typeof VISUAL_SKILLS[number];
export interface VisualObservation {
  schema: "viscera.visual-skills/1"; image: string; state: number[];
  capturedAt: number; sceneSignature: string;
}
export interface VisualDecision {
  requestId: string; skill: VisualSkill; scores: number[]; margin: number;
  modelId: string; inferenceMs: number; accepted: boolean;
  roundTripMs?: number;
}
export function visualState(metadata: any, previous: VisualSkill | "none"): number[] {
  const camera = metadata.camera, tools = metadata.tools, physics = metadata.physics;
  const direction = camera.target.map((v: number, i: number) => v - camera.position[i]);
  const length = Math.hypot(...direction) || 1;
  const state = [...camera.position.map((v: number) => v / 500), ...direction.map((v: number) => v / length),
    Number(tools.active), tools.jawClosure ?? 0, (physics?.displacement_mm ?? 0) / 5,
    (tools.reactionN ?? 0) / .8, ...["none", ...VISUAL_SKILLS].map(skill => Number(skill === previous))];
  if (state.length !== 16 || state.some(v => !Number.isFinite(v) || Math.abs(v) > 10)) throw new Error("Invalid visual policy state.");
  return state;
}
export function visualSceneSignature(metadata: any): string {
  const rounded = (values: number[]) => values.map(v => Math.round(v * 1e6) / 1e6);
  return JSON.stringify([rounded(metadata.camera.position), rounded(metadata.camera.target), rounded(metadata.camera.up ?? [0,1,0]), metadata.camera.fov, metadata.camera.aspect,
    metadata.organs.map((o: any) => [o.id, o.geometrySignature, o.materialSignature, o.visible])]);
}
export function validateVisualDecision(value: unknown, requestId: string): VisualDecision {
  const v = value as VisualDecision;
  if (!v || v.requestId !== requestId || !VISUAL_SKILLS.includes(v.skill) || !Array.isArray(v.scores) || v.scores.length !== 5 || v.scores.some(s => !Number.isFinite(s) || Math.abs(s) >= 3) || !Number.isFinite(v.inferenceMs) || v.inferenceMs < 0 || v.inferenceMs > 7000 || typeof v.modelId !== "string") throw new Error("Invalid visual policy reply.");
  const order = v.scores.map((score, index) => ({score, index})).sort((a, b) => b.score - a.score);
  const margin = order[0]!.score - order[1]!.score;
  if (v.skill !== VISUAL_SKILLS[order[0]!.index] || Math.abs(margin - v.margin) > 1e-4 || !v.accepted || margin < .5) throw new Error("The visual policy abstained; no motion was started.");
  return v;
}
export function assertSkillTransition(previous: VisualSkill | "none", next: VisualSkill) {
  const allowed = previous === "none" ? "look" : previous === "look" ? "grasp" : previous === "grasp" ? "release" : previous === "release" ? "finish" : "wait";
  if (next !== allowed) throw new Error(next === "wait" ? "The visual policy requested a stop." : "The predicted skill does not satisfy the task preconditions.");
}
export const VISUAL_SERVICE_URL = "http://127.0.0.1:8877";
export async function predictVisualSkill(observation: VisualObservation, instruction: string, signal: AbortSignal): Promise<VisualDecision> {
  const requestId = crypto.randomUUID(), began = performance.now();
  signal.throwIfAborted();
  const timeout = AbortSignal.timeout(7000);
  const response = await fetch(`${VISUAL_SERVICE_URL}/predict`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...observation, instruction, requestId }), signal: AbortSignal.any([signal, timeout]) });
  if (!response.ok) throw new Error(response.status === 503 ? "Visual policy is not ready. Start the local inference service." : "Visual inference failed; task stopped.");
  const decision = validateVisualDecision(await response.json(), requestId);
  signal.throwIfAborted();
  if (performance.now() - began > 7000) throw new Error("Visual decision expired.");
  return {...decision, roundTripMs: performance.now() - began};
}
