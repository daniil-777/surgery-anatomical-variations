import { describe, expect, it } from "vitest";
import {
  CAMERA_REWARD_VERSION, CAMERA_REWARD_WEIGHTS, cameraViewQuality, rolloutCameraPolicy, trainCameraPolicy,
  validateCameraGraph, validateCameraPolicy, type CameraPolicy, type CameraViewGraph,
} from "./cameraRL";

/** The cheap spur exposes target A, but returning to it after inspection is
 * locally cheaper than taking the detour to B. A memoryless greedy controller
 * loops; a coverage-state TD policy must learn the delayed second reward. */
function detour(): CameraViewGraph {
  const features = { luminance: .5, contrast: .4, glare: .02, dark: .03, depthP10: 20, depthMedian: 35, depthP90: 60, validDepth: .95, nearFraction: .01, sharpness: .6 };
  return {
    version: "test-rgbd/1", fingerprint: "detour-fixture-with-observed-two-landmarks", startNode: 0,
    observation: { width: 2, height: 2, near: .1, far: 100 }, targets: [{ id: "a", label: "Landmark A" }, { id: "b", label: "Landmark B" }],
    nodes: [0, 1, 2, 3, 4].map(id => ({ id, pose: { position: [id * 2, 0, 0], direction: [0, 0, -1], up: [0, 1, 0], insertionMm: id, yaw: 0, pitch: 0 }, features: { ...features }, visibleMask: id === 1 ? 1 : id === 3 ? 2 : 0, quality: .8, clearanceMm: 5 })),
    edges: [
      [{ to: 1, distanceMm: 1, angleRad: .05 }, { to: 2, distanceMm: 12, angleRad: .2 }, { to: 4, distanceMm: 15, angleRad: .2 }],
      [{ to: 0, distanceMm: 1, angleRad: .05 }],
      [{ to: 0, distanceMm: 12, angleRad: .2 }, { to: 3, distanceMm: 12, angleRad: .2 }],
      [{ to: 2, distanceMm: 12, angleRad: .2 }],
      [{ to: 0, distanceMm: 15, angleRad: .2 }],
    ],
  };
}
const config = { seed: 41, episodes: 1200, goalMask: 3, maxSteps: 20 };
const clone = <T>(input: T): T => JSON.parse(JSON.stringify(input)) as T;
function deepFreeze<T>(input: T): T {
  if (input && typeof input === "object") { Object.freeze(input); for (const value of Object.values(input)) deepFreeze(value); }
  return input;
}

describe("finite RGBD camera Double-Q learner", () => {
  it("learns the delayed detour from zero initialization with actual TD and eight Dyna replays", () => {
    const graph = detour(), policy = trainCameraPolicy(graph, config);
    const learned = rolloutCameraPolicy(graph, policy), greedy = rolloutCameraPolicy(graph, policy, 0, "greedy");
    expect(policy.q.some(q => q !== 0)).toBe(true);
    expect(policy.training.updates).toBeGreaterThan(1000);
    expect(policy.training.dynaUpdates * 9).toBe(policy.training.updates * 8);
    expect(policy.training.meanAbsTd).toBeGreaterThan(0);
    expect(learned.success).toBe(true); expect(learned.coverage).toBe(1); expect(learned.steps).toBeLessThanOrEqual(6);
    expect(learned.route).toContain(1); expect(learned.route).toContain(3);
    expect(greedy.success).toBe(false); expect(greedy.termination).toBe("step-limit"); expect(learned.return).toBeGreaterThan(greedy.return);
    // Learned inference is genuinely table based and never silently falls back
    // to a greedy planner or a pre-authored successful route.
    const blank: CameraPolicy = { ...policy, q: policy.q.map(() => 0) };
    expect(rolloutCameraPolicy(graph, blank).success).toBe(false);
  });

  it("reproduces weights, held-out split, curves and baselines exactly by seed", () => {
    const graph = detour(), one = trainCameraPolicy(graph, config), two = trainCameraPolicy(graph, config);
    expect(two).toEqual(one);
    const other = trainCameraPolicy(graph, { ...config, seed: 97 });
    // A small finite MDP may converge to exactly the same optimal values for
    // different seeds; the exploration/training history must still differ.
    expect(other.training.curve).not.toEqual(one.training.curve);
    expect(rolloutCameraPolicy(graph, one, 0, "random")).toEqual(rolloutCameraPolicy(graph, one, 0, "random"));
  });

  it("holds out reset starts and evaluates all three controllers without weight updates", () => {
    const graph = deepFreeze(detour()), policy = trainCameraPolicy(graph, config);
    expect(policy.training.holdoutStarts.length).toBeGreaterThan(0);
    expect(policy.training.trainingStarts).toContain(graph.startNode);
    expect(policy.training.holdoutStarts.every(id => !policy.training.trainingStarts.includes(id))).toBe(true);
    const weights = [...policy.q]; deepFreeze(policy);
    for (const mode of ["learned", "greedy", "random"] as const) {
      const summary = policy.evaluation[mode];
      expect(summary.rollouts.map(run => run.startNode)).toEqual(policy.training.holdoutStarts);
      for (const run of summary.rollouts) expect(rolloutCameraPolicy(graph, policy, run.startNode, mode)).toEqual(run);
    }
    expect(policy.q).toEqual(weights);
  });

  it("records normalized reward priorities and applies stronger travel/turn/glare penalties", () => {
    const graph = detour(), coverage = trainCameraPolicy(graph, { ...config, episodes: 80 }), steady = trainCameraPolicy(graph, { ...config, episodes: 80, priority: "steady" });
    expect(coverage.config.priority).toBe("coverage"); expect(steady.config.priority).toBe("steady");
    expect(steady.rewardVersion).toBe(CAMERA_REWARD_VERSION); expect(CAMERA_REWARD_WEIGHTS.steady.angle).toBeGreaterThan(CAMERA_REWARD_WEIGHTS.coverage.angle);
    expect(steady.q).not.toEqual(coverage.q);
    const moreGlare = clone(graph.nodes[0]!); moreGlare.features.glare = .9;
    expect(cameraViewQuality(moreGlare)).toBeLessThan(cameraViewQuality(graph.nodes[0]!));
  });

  it("terminates unreachable-from-a-start rollouts honestly and never trains unavailable targets", () => {
    const graph = detour(); graph.edges[4] = [];
    const policy = trainCameraPolicy(graph, { ...config, episodes: 80 });
    const stranded = rolloutCameraPolicy(graph, policy, 4);
    expect(stranded).toMatchObject({ success: false, termination: "dead-end", steps: 0, coverage: 0, route: [4] });
    graph.edges[2] = [{ to: 0, distanceMm: 12, angleRad: .2 }];
    expect(() => trainCameraPolicy(graph, config)).toThrow(/unavailable/);
  });

  it("reports a single already-completed view without inventing holdout evidence", () => {
    const graph = detour(); graph.nodes = [graph.nodes[0]!]; graph.nodes[0]!.visibleMask = 3; graph.edges = [[]];
    const policy = trainCameraPolicy(graph, { ...config, episodes: 1 });
    expect(policy.training.updates).toBe(0); expect(policy.training.holdoutStarts).toEqual([]);
    expect(policy.evaluation.learned.rollouts).toEqual([]);
    expect(rolloutCameraPolicy(graph, policy)).toMatchObject({ success: true, termination: "goal", steps: 0, coverage: 1 });
    expect(validateCameraPolicy(graph, policy)).toEqual(policy);
  });

  it("bounds jobs and rejects malformed RGBD graphs before learning", () => {
    for (const patch of [{ episodes: 10001 }, { episodes: 0 }, { seed: -1 }, { seed: .2 }, { maxSteps: 257 }, { goalMask: 0 }, { goalMask: 8 }, { priority: "unsafe" }]) {
      expect(() => trainCameraPolicy(detour(), { ...config, ...patch } as typeof config)).toThrow();
    }
    const mutations: ((graph: CameraViewGraph) => void)[] = [
      graph => { graph.nodes[0]!.features.depthMedian = NaN; },
      graph => { graph.nodes[0]!.features.validDepth = 1.1; },
      graph => { graph.nodes[0]!.features.depthP10 = 90; },
      graph => { graph.nodes[0]!.pose.direction = [0, 0, 0]; },
      graph => { graph.edges[0]!.push(graph.edges[0]![0]!); },
      graph => { graph.edges[0]![0]!.to = 99; },
      graph => { graph.nodes[0]!.rgb = [0, 1, 2]; },
      graph => { graph.nodes[0]!.depth = [1, 2, Infinity, 4]; },
      graph => { graph.targets = Array.from({ length: 7 }, (_, i) => ({ id: `${i}`, label: `${i}` })); },
      graph => { graph.nodes = Array.from({ length: 49 }, () => graph.nodes[0]!); },
      graph => { graph.observation.width = 4096; },
    ];
    for (const mutate of mutations) { const graph = detour(); mutate(graph); expect(() => validateCameraGraph(graph)).toThrow(); }
  });

  it("round-trips bounded policies and rejects wrong-scene, malformed or nonfinite imports", () => {
    const graph = detour(), policy = trainCameraPolicy(graph, { ...config, episodes: 80 });
    const accepted = validateCameraPolicy(graph, clone(policy)); expect(accepted).toEqual(policy); expect(accepted.q).not.toBe(policy.q);
    const mutations: ((policy: CameraPolicy) => void)[] = [
      policy => { policy.fingerprint = "different-geometry"; },
      policy => { policy.version = "future-schema"; },
      policy => { policy.rewardVersion = "different-reward"; },
      policy => { policy.nodeCount++; },
      policy => { policy.q.pop(); },
      policy => { policy.q[0] = Infinity; },
      policy => { policy.config.maxSteps = 10000000; },
      policy => { policy.training.curve[0]!.meanAbsTd = NaN; },
      policy => { policy.training.holdoutStarts.push(policy.training.trainingStarts[0]!); },
      policy => { policy.evaluation.learned.rollouts[0]!.route = [99]; },
      policy => { policy.evaluation.learned.meanReturn += 1; },
      policy => { policy.evaluation.learned.rollouts[0]!.return += 1; },
    ];
    for (const mutate of mutations) { const altered = clone(policy); mutate(altered); expect(() => validateCameraPolicy(graph, altered)).toThrow(); }
    for (const bad of [null, [], "policy", {}, { ...policy, q: new Float64Array(policy.q) }, { ...policy, extra: [] }]) expect(() => validateCameraPolicy(graph, bad)).toThrow();
  });

  it("bounds the largest six-target state table and repeated unseen-start inference", () => {
    const graph = detour(), original = graph.nodes[0]!;
    graph.targets = Array.from({ length: 6 }, (_, i) => ({ id: `landmark-${i}`, label: `Landmark ${i}` }));
    graph.nodes = Array.from({ length: 48 }, (_, id) => ({ ...clone(original), id, visibleMask: id % 8 === 0 ? 1 << (Math.floor(id / 8) % 6) : 0 }));
    graph.edges = graph.nodes.map((node, i) => [{ to: (i + 1) % 48, distanceMm: 2, angleRad: .02 }, { to: (i + 47) % 48, distanceMm: 2, angleRad: .02 }]);
    const policy = trainCameraPolicy(graph, { seed: 9, episodes: 100, goalMask: 63, maxSteps: 80 });
    expect(policy.q).toHaveLength(147456); expect(policy.q.every(Number.isFinite)).toBe(true);
    expect(policy.training.holdoutStarts).toHaveLength(8);
    const before = [...policy.q];
    for (const start of policy.training.holdoutStarts) for (const mode of ["learned", "greedy", "random"] as const) {
      const result = rolloutCameraPolicy(graph, policy, start, mode);
      expect(result.route.length).toBeLessThanOrEqual(81); expect(result.route.every(id => id >= 0 && id < 48)).toBe(true);
      expect(Number.isFinite(result.return)).toBe(true);
    }
    expect(policy.q).toEqual(before); expect(validateCameraPolicy(graph, policy).q).toEqual(before);
  });

  it("publishes real progress and lets the caller cancel without a completed policy", () => {
    const episodes: number[] = [];
    expect(() => trainCameraPolicy(detour(), config, progress => { episodes.push(progress.episode); if (progress.episode === 7) throw new Error("cancelled"); })).toThrow("cancelled");
    expect(episodes).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(trainCameraPolicy(detour(), { ...config, episodes: 10 }).training.curve.at(-1)?.episode).toBe(10);
  });
});
