import { describe, it, expect } from "vitest";
import { evaluateGrasp, trainGraspPolicy, revalidateGraspPolicy, graspOffset, graspViolation, smoothGrasp, GRASP_PROFILES, GRASP_LIMITS, type GraspTrainingInput, type GraspPolicy } from "./graspPolicy";
import saved from "./graspDefaultPolicy.json";
const input = (): GraspTrainingInput => ({
  organs: [{ id: "liver", category: "digestive", bounds: { min: [-80, -45, -30], max: [80, 45, 30] } }],
  materials: { schema_version: "whole-scene-materials-1.0.0", model_id: "a".repeat(64), scope: "unit simulation fixture", materials: [{ id: "liver", young_pa: 3500, relaxation_fraction: .35, relaxation_time_s: .4, density_kg_m3: 1050, accepted_for_application: true, observation_origin: "synthetic-design-history" }] },
  responses: { liver: { strainStiffening: 14, localDampingRatio: .9, supportRadiusRatio: .9 } }, attachments: [],
  contact: { mode: "grasp", organId: "liver", restPointMm: [0, 0, 30], targetPointMm: [0, 0, 30], normal: [0, 0, 1], radiusMm: 3 },
});
describe("isolated grasp option learning", () => {
  it("replays the bundled learned policy from its recorded training input", () => {
    const policy = trainGraspPolicy(saved.trainingInput as unknown as GraspTrainingInput, saved.policy.seed);
    policy.q.forEach((q, i) => expect(q).toBeCloseTo(saved.policy.q[i]!, 12)); expect(policy.visits).toEqual(saved.policy.visits);
    expect(policy.action).toBe(saved.policy.action); expect(GRASP_PROFILES[policy.action]!.liftMm).toBe(4);
    expect(policy.evaluation[1]!.holdDisplacementMm).toBeGreaterThan(3);
    const gentle = evaluateGrasp(saved.trainingInput as unknown as GraspTrainingInput, 0);
    expect(policy.evaluation[1]!.holdDisplacementMm).toBeGreaterThan(gentle.holdDisplacementMm * 1.8);
    expect(policy.evaluation.every(e => e.peakForceN < GRASP_LIMITS.forceN && e.peakGradient < GRASP_LIMITS.gradient && e.recoveryMm < .2)).toBe(true); policy.evaluation.forEach((trial, i) => { for (const [key, value] of Object.entries(trial)) {
      const expected = (saved.policy.evaluation[i]! as unknown as Record<string, unknown>)[key];
      if (typeof value === "number") expect(value).toBeCloseTo(expected as number, 12); else expect(value).toBe(expected);
    } });
  }, 30000);
  it("revalidates every stiffness case at the actual new contact without claiming new training", () => {
    const source = saved.policy as GraspPolicy, before = JSON.stringify(source), changed = input();
    changed.materials.materials[0]!.young_pa = 6100;
    const progress: number[] = [], result = revalidateGraspPolicy(changed, source, done => progress.push(done));
    expect(progress).toEqual([1, 2, 3]); expect(result.episodes).toBe(12); expect(result.q).toEqual(source.q);
    expect(result.evaluation).toEqual([.8, 1, 1.2].map(scale => evaluateGrasp(changed, source.action, scale)));
    expect(result.evaluation).not.toEqual(source.evaluation);
    expect(result.modelId).toBe(changed.materials.model_id); expect(result.revalidation?.sourceModelId).toBe(source.modelId);
    expect(result.revalidation?.baselineScope).toBe("original training scene"); expect(JSON.stringify(source)).toBe(before);
    expect(() => revalidateGraspPolicy(changed, { ...source, evaluation: [] })).toThrow();
    expect(() => revalidateGraspPolicy(changed, { ...source, action: (source.action + 1) % 3 })).toThrow();
    changed.materials.materials[0]!.young_pa = NaN;
    expect(() => revalidateGraspPolicy(changed, source)).toThrow();
  }, 10000);
  it("learns reproducible nonzero action values from actual tissue rollouts and freezes the evaluated policy", () => {
    const source = input(), unchanged = JSON.stringify(source), a = trainGraspPolicy(source, 42), b = trainGraspPolicy(source, 42);
    expect(a.q).toEqual(b.q); expect(a.trials).toEqual(b.trials); expect(a.visits.reduce((sum, n) => sum + n, 0)).toBe(12);
    expect(a.visits.every(n => n > 0)).toBe(true); expect(a.q.some(q => q !== 0)).toBe(true);
    expect(a.action).toBe(a.q.indexOf(Math.max(...a.q))); expect(a.evaluation.map(e => e.stiffnessScale)).toEqual([.8, 1, 1.2]);
    expect(a.evaluation.every(e => e.success && e.action === a.action && e.peakForceN < GRASP_LIMITS.forceN && e.recoveryMm < .2)).toBe(true);
    expect(a.trials.every(e => e.stiffnessScale >= .85 && e.stiffnessScale <= 1.15)).toBe(true);
    expect(a.q[a.action]!).toBeGreaterThan(a.q.reduce((sum, v) => sum + v, 0) / a.q.length);
    expect(JSON.stringify(source)).toBe(unchanged);
  }, 15000);
  it("tracks lower motion for a stiffer tissue assignment without changing its material data", () => {
    const source = input(), soft = evaluateGrasp(source, 0, .8), stiff = evaluateGrasp(source, 0, 1.2);
    expect(soft.success && stiff.success).toBe(true); expect(stiff.peakForceN).toBeGreaterThan(soft.peakForceN);
    expect(stiff.holdDisplacementMm).toBeLessThan(soft.holdDisplacementMm);
  });
  it("rejects unsupported task, action, seed and invalid learned materials", () => {
    expect(() => evaluateGrasp({ ...input(), contact: { ...input().contact, organId: "gallbladder" } }, 0)).toThrow();
    expect(() => evaluateGrasp(input(), 9)).toThrow(); expect(() => trainGraspPolicy(input(), NaN)).toThrow();
    const invalid = input(); invalid.materials.materials[0]!.young_pa = NaN; expect(() => evaluateGrasp(invalid, 0)).toThrow();
  });
  it("bounds target speed, reaches the selected lift, then returns continuously to zero", () => {
    for (let exponent = 2; exponent <= 16; exponent++) { const value = smoothGrasp(1 - 10 ** -exponent); expect(value).toBeLessThanOrEqual(1); expect(value).toBeGreaterThanOrEqual(0); }
    GRASP_PROFILES.forEach((profile, action) => {
      let previous = graspOffset(action, 0), peak = 0;
      for (let t = .001; t <= profile.rampSeconds * 2 + profile.holdSeconds + .1; t += .001) {
        const current = graspOffset(action, t); peak = Math.max(peak, Math.abs(current - previous) / .001); previous = current;
        expect(current).toBeGreaterThanOrEqual(0); expect(current).toBeLessThanOrEqual(GRASP_LIMITS.liftMm);
      }
      expect(peak).toBeLessThanOrEqual(GRASP_LIMITS.targetSpeedMmS); expect(previous).toBe(0);
      expect(graspOffset(action, profile.rampSeconds + profile.holdSeconds / 2)).toBe(profile.liftMm);
    });
  });
  it.each([
    { forceN: .81 }, { displacementMm: 5.01 }, { gradient: .351 }, { residualMm: 2.01 }, { finite: false }, { clamped: true }, { forceN: NaN },
  ])("rejects an unsafe feedback sample %j", patch => {
    expect(graspViolation({ forceN: .1, displacementMm: 1, gradient: .1, residualMm: .1, finite: true, clamped: false, ...patch })).toBeTruthy();
  });
});
