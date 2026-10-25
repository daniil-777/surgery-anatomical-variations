import { describe, expect, it } from "vitest";
import artifact from "../public/camera-policies/virtamed-survey-v1.json";
import { readDefaultCameraPolicy } from "./cameraDefaultPolicy";
import { conditionCameraGoal, assessCameraGoal } from "./cameraGoalPolicy";
import { trainCameraPolicy, rolloutCameraPolicy } from "./cameraRL";
import type { CameraTrainingScene } from "./cameraPlannerScene";
function fixture(): CameraTrainingScene {
  const saved = readDefaultCameraPolicy(artifact), graph = saved.graph;
  const copy = structuredClone(graph); copy.targets = [{ id: "liver", label: "Liver" }, { id: "gallbladder", label: "Gallbladder" }]; copy.nodes.forEach(n => { n.visibleMask = 3; n.clearanceMm = 50; });
  const count = copy.nodes.length;
  const targetPixels = Array.from({ length: count }, () => [100, 100]), targetCenterErrors = Array.from({ length: count }, () => [.5, .5]), targetDepths = Array.from({ length: count }, () => [180, 180]);
  targetPixels[15] = [1382, 100]; targetCenterErrors[15] = [0, .5]; targetDepths[15] = [65, 180];
  targetPixels[22] = [100, 676]; targetCenterErrors[22] = [.5, 0]; targetDepths[22] = [180, 65];
  return { graph: copy, port: saved.port, fov: saved.fov, revision: 1, workspace: { min: [-500, -500, -500], max: [500, 500, 500] }, captureMs: 0, graphMs: 0, blockedEdges: 0, captureTimesMs: [], targetPixels, targetCenterErrors, targetDepths, observationConvention: "fixture" };
}
describe("organ-conditioned inspection policy", () => {
  it("learns distinct organ destinations instead of stopping when the organ is merely visible", () => {
    const original = fixture(), before = structuredClone(original);
    for (const [organ, expected] of [["liver", 15], ["gallbladder", 22]] as const) {
      const scene = conditionCameraGoal(original, organ);
      expect(scene.goal!.node).toBe(expected); expect(scene.graph.nodes[0]!.visibleMask).toBe(0);
      for (const seed of [42, 117, 901]) {
        const policy = trainCameraPolicy(scene.graph, { seed, episodes: 10000, goalMask: 1, priority: "steady" });
        const run = rolloutCameraPolicy(scene.graph, policy), audit = assessCameraGoal(scene, policy);
        expect(run.success).toBe(true); expect(run.route.at(-1)).toBe(expected); expect(run.steps).toBeGreaterThan(0);
        expect(audit.accepted).toBe(true); expect(audit.successRate).toBe(1);
      }
    }
    expect(original).toEqual(before);
  });
  it("rejects occluded, too-close and uncentered goals without altering the map", () => {
    for (const field of ["absent", "depth", "center", "clearance"] as const) {
      const scene = fixture();
      if (field === "absent") scene.targetPixels.forEach(p => p.fill(0));
      if (field === "depth") scene.targetDepths!.forEach(p => p.fill(15));
      if (field === "center") scene.targetCenterErrors!.forEach(p => p.fill(.8));
      if (field === "clearance") scene.graph.nodes.forEach(n => { n.clearanceMm = 1; });
      expect(() => conditionCameraGoal(scene, "liver")).toThrow(/no clear inspection/i);
    }
  });
  it("holds an already optimal inspection pose and detects unsuccessful unlearned actions", () => {
    const scene = fixture(); scene.graph.startNode = 15;
    const goal = conditionCameraGoal(scene, "liver"), policy = trainCameraPolicy(goal.graph, { seed: 42, episodes: 10000, goalMask: 1 });
    expect(rolloutCameraPolicy(goal.graph, policy).steps).toBe(0);
    const blank = { ...policy, q: policy.q.map(() => 0) };
    expect(assessCameraGoal(goal, blank).accepted).toBe(false);
  });
});
