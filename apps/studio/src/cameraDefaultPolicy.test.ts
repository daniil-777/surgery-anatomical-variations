import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import artifact from "../public/camera-policies/virtamed-survey-v1.json";
import { bindDefaultCameraPolicy, readDefaultCameraPolicy } from "./cameraDefaultPolicy";
import { trainCameraPolicy } from "./cameraRL";
import type { CameraTrainingScene } from "./cameraPlannerScene";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const saved = readDefaultCameraPolicy(structuredClone(artifact));
  const live: CameraTrainingScene = { graph: structuredClone(saved.graph), port: [...saved.port], fov: saved.fov, revision: 17,
    workspace: { min: [-500, -500, -500], max: [500, 500, 500] }, captureMs: 100, graphMs: 5, blockedEdges: 0, captureTimesMs: [], targetPixels: [], observationConvention: "test" };
  return { saved, live };
}
describe("shipped learned camera weights", () => {
  it("reproduces the exact weights and reserved-start evaluation from the recorded RGBD graph", () => {
    const { saved } = fixture(), learned = trainCameraPolicy(saved.graph, saved.policy.config);
    expect(saved.policy).toEqual(learned);
    expect(saved.policy.training.updates).toBe(87903);
    expect(saved.policy.evaluation.learned.successRate).toBe(1);
    expect(hash(JSON.stringify(saved.policy.q))).toBe(saved.provenance.weightsSha256);
    expect(hash(JSON.stringify(saved.graph))).toBe(saved.provenance.sourceSha256);
    expect(hash(readFileSync(new URL("./cameraRL.ts", import.meta.url)))).toBe(saved.provenance.learnerSha256);
  });
  it("revalidates small GPU observation differences without changing any learned weights", () => {
    const { saved, live } = fixture(), before = structuredClone(saved);
    live.graph.fingerprint = live.graph.fingerprint.split("-")[0] + "-fresh-render";
    live.graph.nodes.forEach(node => { node.features.luminance += .001; node.quality += .001; });
    const next = bindDefaultCameraPolicy(saved, live);
    expect(next.q).toEqual(saved.policy.q); expect(next.training).toEqual(saved.policy.training);
    expect(next.fingerprint).toBe(live.graph.fingerprint); expect(next.evaluation.learned.successRate).toBe(1);
    expect(next.evaluation.learned.meanReturn).not.toBe(saved.policy.evaluation.learned.meanReturn);
    expect(saved).toEqual(before);
  });
  it("rejects geometry, material, target, pose, clearance, depth, image or edge incompatibilities", () => {
    const mutations: ((live: CameraTrainingScene) => void)[] = [
      live => { live.graph.fingerprint = "changed-anatomy"; },
      live => { live.graph.targets[0]!.id = "changed-target"; },
      live => { live.graph.nodes[0]!.pose.position[0] += 1; },
      live => { live.graph.nodes[0]!.visibleMask = 0; },
      live => { live.graph.nodes[0]!.clearanceMm = 1; },
      live => { live.graph.nodes[0]!.features.depthMedian += 5; },
      live => { live.graph.nodes[0]!.features.luminance += .1; },
      live => { live.graph.edges[0]!.pop(); },
      live => { live.fov += 1; }, live => { live.port[0] += 1; },
    ];
    for (const mutate of mutations) { const { saved, live } = fixture(); mutate(live); expect(() => bindDefaultCameraPolicy(saved, live)).toThrow(); }
  });
  it("rejects nonlearned or malformed artifacts and owns the accepted Q table", () => {
    const raw = structuredClone(artifact), saved = readDefaultCameraPolicy(raw);
    raw.policy.q[0] = 999; expect(saved.policy.q[0]).not.toBe(999);
    for (const value of [null, {}, { ...artifact, demonstrationStart: 0 }, { ...artifact, format: "future" }]) expect(() => readDefaultCameraPolicy(value)).toThrow();
    const zero = structuredClone(artifact); zero.policy.q.fill(0); expect(() => readDefaultCameraPolicy(zero)).toThrow();
  });
});
