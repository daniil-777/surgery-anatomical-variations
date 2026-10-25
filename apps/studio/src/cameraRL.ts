/** Browser/Worker compatible finite-view camera learning. Geometry and RGBD
 * acquisition belong to the viewport; this module never mutates the scene. */
export const CAMERA_RL_VERSION = "viscera.camera-rl.double-q/1";
export const CAMERA_REWARD_VERSION = "viscera.camera-coverage-reward/1";
/** Reward units: a new landmark is 4, completing the task adds 6. Distances
 * are millimetres and rotations are radians. Both modes penalize every move;
 * steady adds stronger travel, angular-motion and saturated-pixel penalties. */
export const CAMERA_REWARD_WEIGHTS = {
  coverage: { newTarget: 4, completion: 6, step: .16, distance: .006, angle: .12, imageQuality: .08, glare: .12 },
  steady: { newTarget: 4, completion: 6, step: .18, distance: .012, angle: .45, imageQuality: .10, glare: .35 },
} as const;
export interface CameraPose {
  position: [number, number, number]; direction: [number, number, number]; up: [number, number, number];
  insertionMm: number; yaw: number; pitch: number;
}
export interface RGBDFeatures {
  luminance: number; contrast: number; glare: number; dark: number;
  depthP10: number; depthMedian: number; depthP90: number; validDepth: number; nearFraction: number; sharpness: number;
}
export interface CameraViewNode {
  id: number; pose: CameraPose; features: RGBDFeatures; visibleMask: number; quality: number; clearanceMm: number;
  rgb?: number[]; depth?: number[];
}
export interface CameraViewEdge { to: number; distanceMm: number; angleRad: number }
export interface CameraViewGraph {
  version: string; fingerprint: string; nodes: CameraViewNode[]; edges: CameraViewEdge[][];
  targets: { id: string; label: string }[]; startNode: number;
  observation: { width: number; height: number; near: number; far: number };
}
export interface CameraRLConfig { seed: number; episodes: number; goalMask: number; maxSteps?: number; priority?: "coverage" | "steady" }
export interface CameraTrainingProgress { episode: number; episodes: number; return: number; meanAbsTd: number; epsilon: number }
export type CameraPolicyMode = "learned" | "greedy" | "random";
export interface CameraRollout {
  startNode: number; route: number[]; inspectedMask: number; coverage: number; success: boolean; steps: number;
  return: number; distanceMm: number; angleRad: number; meanQuality: number;
  termination: "goal" | "step-limit" | "dead-end";
}
export interface CameraEvaluationSummary {
  successRate: number; meanCoverage: number; meanReturn: number; meanSteps: number; meanDistanceMm: number;
  meanAngleRad: number; meanQuality: number; rollouts: CameraRollout[];
}
export interface CameraPolicy {
  version: string; rewardVersion: string; fingerprint: string; graphVersion: string; nodeCount: number; targetCount: number;
  config: Required<CameraRLConfig>; q: number[];
  training: {
    curve: CameraTrainingProgress[]; updates: number; dynaUpdates: number; meanAbsTd: number;
    trainingStarts: number[]; holdoutStarts: number[];
  };
  evaluation: { heldOutStarts: number[]; learned: CameraEvaluationSummary; greedy: CameraEvaluationSummary; random: CameraEvaluationSummary };
}

const MAX_NODES = 48, MAX_TARGETS = 6, MAX_Q = MAX_NODES * MAX_NODES * (1 << MAX_TARGETS);
const GAMMA = .96, DYNA_REPLAYS = 8;
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const bounded = (v: unknown, lo: number, hi: number): v is number => finite(v) && v >= lo && v <= hi;
const integer = (v: unknown, lo: number, hi: number): v is number => bounded(v, lo, hi) && Number.isInteger(v);
function requireThat(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function exactKeys(value: unknown, keys: string[]) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const bitCount = (mask: number) => { let count = 0; for (; mask; mask &= mask - 1) count++; return count; };
const textField = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
function rng(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

/** Validate bounded inputs before allocating a learner table or accepting a
 * worker job. The graph may contain only already guarded, collision-free edges. */
export function validateCameraGraph(graph: CameraViewGraph): void {
  requireThat(graph && textField(graph.version) && textField(graph.fingerprint), "Invalid camera graph identity.");
  requireThat(Array.isArray(graph.nodes) && integer(graph.nodes.length, 1, MAX_NODES), "Camera graph requires 1–48 nodes.");
  requireThat(Array.isArray(graph.targets) && integer(graph.targets.length, 1, MAX_TARGETS), "Camera graph requires 1–6 targets.");
  requireThat(graph.targets.every(t => t && textField(t.id) && textField(t.label)) && new Set(graph.targets.map(t => t.id)).size === graph.targets.length, "Invalid or duplicate camera targets.");
  requireThat(integer(graph.startNode, 0, graph.nodes.length - 1), "Invalid camera start node.");
  const observation = graph.observation;
  requireThat(observation && integer(observation.width, 1, 128) && integer(observation.height, 1, 128) && bounded(observation.near, .001, 1000) && bounded(observation.far, observation.near + .001, 100000), "Invalid RGBD observation dimensions or clipping distances.");
  const fullMask = (1 << graph.targets.length) - 1, pixels = observation.width * observation.height;
  requireThat(Array.isArray(graph.edges) && graph.edges.length === graph.nodes.length, "Invalid camera graph adjacency.");
  graph.nodes.forEach((node, i) => {
    requireThat(node && node.id === i && integer(node.visibleMask, 0, fullMask) && bounded(node.quality, 0, 1) && bounded(node.clearanceMm, 0, 100000), "Invalid camera view node.");
    const p = node.pose, f = node.features;
    requireThat(p && [p.position, p.direction, p.up].every(v => Array.isArray(v) && v.length === 3 && v.every(n => bounded(n, -100000, 100000))) && bounded(p.insertionMm, 0, 100000) && bounded(p.yaw, -1000, 1000) && bounded(p.pitch, -Math.PI, Math.PI), "Invalid camera pose.");
    requireThat(Math.abs(Math.hypot(...p.direction) - 1) < .001 && Math.abs(Math.hypot(...p.up) - 1) < .001, "Camera direction and up must be unit vectors.");
    requireThat(f && [f.luminance, f.contrast, f.glare, f.dark, f.validDepth, f.nearFraction, f.sharpness].every(n => bounded(n, 0, 1)) && [f.depthP10, f.depthMedian, f.depthP90].every(n => bounded(n, 0, observation.far)) && f.depthP10 <= f.depthMedian && f.depthMedian <= f.depthP90, "Invalid RGBD camera features.");
    if (node.rgb !== undefined) requireThat(Array.isArray(node.rgb) && [pixels * 3, pixels * 4].includes(node.rgb.length) && node.rgb.every(n => bounded(n, 0, 255)), "Invalid RGB camera image.");
    if (node.depth !== undefined) requireThat(Array.isArray(node.depth) && node.depth.length === pixels && node.depth.every(n => bounded(n, 0, observation.far)), "Invalid camera depth image.");
    const edges = graph.edges[i];
    requireThat(Array.isArray(edges) && edges.length <= graph.nodes.length - 1 && new Set(edges.map(e => e?.to)).size === edges.length, "Invalid or duplicate camera edges.");
    for (const edge of edges) requireThat(edge && integer(edge.to, 0, graph.nodes.length - 1) && edge.to !== i && bounded(edge.distanceMm, 0, 100000) && bounded(edge.angleRad, 0, Math.PI + 1e-6), "Invalid camera edge.");
  });
}

function normalizeConfig(graph: CameraViewGraph, config: CameraRLConfig): Required<CameraRLConfig> {
  requireThat(config && integer(config.seed, 0, 4294967295) && integer(config.episodes, 1, 10000), "Camera training requires an unsigned seed and 1–10000 episodes.");
  requireThat(integer(config.goalMask, 1, (1 << graph.targets.length) - 1), "Invalid camera coverage goal mask.");
  const reachableMask = reachableNodes(graph).reduce((mask, id) => mask | graph.nodes[id]!.visibleMask, 0);
  requireThat((config.goalMask & reachableMask) === config.goalMask, "Selected camera targets are unavailable from the reachable view graph.");
  const maxSteps = config.maxSteps ?? 64;
  requireThat(integer(maxSteps, 1, 256), "Camera episode step budget must be 1–256.");
  const priority = config.priority ?? "coverage";
  requireThat(priority === "coverage" || priority === "steady", "Unknown camera reward priority.");
  return { seed: config.seed, episodes: config.episodes, goalMask: config.goalMask, maxSteps, priority };
}
function reachableNodes(graph: CameraViewGraph) {
  const seen = new Set([graph.startNode]), queue = [graph.startNode];
  for (let i = 0; i < queue.length; i++) for (const edge of graph.edges[queue[i]!]!) if (!seen.has(edge.to)) { seen.add(edge.to); queue.push(edge.to); }
  return [...seen].sort((a, b) => a - b);
}
const qIndex = (n: number, node: number, mask: number, to: number) => (mask * n + node) * n + to;
const tableSize = (graph: CameraViewGraph) => graph.nodes.length ** 2 * (1 << graph.targets.length);

/** A bounded observation score. Step rewards remain negative without new
 * landmarks, so a policy cannot profit by circling a photogenic view. */
export function cameraViewQuality(node: CameraViewNode) {
  const f = node.features;
  return clamp01(.55 * node.quality + .2 * f.validDepth + .1 * f.contrast + .1 * f.sharpness + .05 * (1 - f.nearFraction) - .15 * f.glare - .15 * f.dark);
}
function transition(graph: CameraViewGraph, config: Required<CameraRLConfig>, mask: number, edge: CameraViewEdge) {
  const nextMask = mask | (graph.nodes[edge.to]!.visibleMask & config.goalMask), done = (nextMask & config.goalMask) === config.goalMask;
  const weights = CAMERA_REWARD_WEIGHTS[config.priority], next = graph.nodes[edge.to]!;
  const reward = weights.newTarget * bitCount(nextMask & ~mask) + (done ? weights.completion : 0) - weights.step - weights.distance * edge.distanceMm - weights.angle * edge.angleRad + weights.imageQuality * cameraViewQuality(next) - weights.glare * next.features.glare;
  return { mask: nextMask, reward, done };
}
function bestEdge(graph: CameraViewGraph, node: number, mask: number, values: ArrayLike<number>): CameraViewEdge | undefined {
  let best: CameraViewEdge | undefined, score = -Infinity;
  for (const edge of graph.edges[node]!) {
    const q = values[qIndex(graph.nodes.length, node, mask, edge.to)]!;
    if (q > score || (q === score && edge.to < (best?.to ?? Infinity))) { best = edge; score = q; }
  }
  return best;
}
function rollout(graph: CameraViewGraph, policy: Pick<CameraPolicy, "q" | "config">, start: number, mode: CameraPolicyMode): CameraRollout {
  const random = rng((policy.config.seed ^ Math.imul(start + 1, 0x9e3779b1) ^ 0x51ed270b) >>> 0);
  let node = start, mask = graph.nodes[start]!.visibleMask & policy.config.goalMask;
  let totalReturn = 0, distanceMm = 0, angleRad = 0, quality = cameraViewQuality(graph.nodes[start]!);
  const route = [start];
  while (route.length <= policy.config.maxSteps && mask !== policy.config.goalMask) {
    const edges = graph.edges[node]!; if (!edges.length) break;
    let edge: CameraViewEdge;
    if (mode === "random") edge = edges[Math.floor(random() * edges.length)]!;
    else if (mode === "greedy") edge = [...edges].sort((a, b) => transition(graph, policy.config, mask, b).reward - transition(graph, policy.config, mask, a).reward || a.to - b.to)[0]!;
    else edge = bestEdge(graph, node, mask, policy.q)!;
    const step = transition(graph, policy.config, mask, edge);
    totalReturn += step.reward; distanceMm += edge.distanceMm; angleRad += edge.angleRad;
    node = edge.to; mask = step.mask; route.push(node); quality += cameraViewQuality(graph.nodes[node]!);
  }
  const success = mask === policy.config.goalMask;
  return { startNode: start, route, inspectedMask: mask, coverage: bitCount(mask) / bitCount(policy.config.goalMask), success,
    steps: route.length - 1, return: totalReturn, distanceMm, angleRad, meanQuality: quality / route.length,
    termination: success ? "goal" : graph.edges[node]!.length === 0 ? "dead-end" : "step-limit" };
}
function summarize(rollouts: CameraRollout[]): CameraEvaluationSummary {
  const mean = (get: (run: CameraRollout) => number) => rollouts.length ? rollouts.reduce((sum, run) => sum + get(run), 0) / rollouts.length : 0;
  return { successRate: mean(run => Number(run.success)), meanCoverage: mean(run => run.coverage), meanReturn: mean(run => run.return),
    meanSteps: mean(run => run.steps), meanDistanceMm: mean(run => run.distanceMm), meanAngleRad: mean(run => run.angleRad), meanQuality: mean(run => run.meanQuality), rollouts };
}

/** Actual off-policy Double-Q TD(0), with eight replay-model updates after
 * each collected transition (Dyna). Initial values are zero, without a route
 * heuristic. Coverage history is part of the state, making the reward Markov. */
export function trainCameraPolicy(graph: CameraViewGraph, supplied: CameraRLConfig, onProgress?: (progress: CameraTrainingProgress) => void): CameraPolicy {
  validateCameraGraph(graph); const config = normalizeConfig(graph, supplied), n = graph.nodes.length, size = tableSize(graph);
  const a = new Float64Array(size), b = new Float64Array(size), visitsA = new Uint32Array(size), visitsB = new Uint32Array(size);
  const random = rng(config.seed), splitRandom = rng((config.seed ^ 0xa5a5a5a5) >>> 0);
  const eligibleStarts = reachableNodes(graph), candidates = eligibleStarts.filter(id => id !== graph.startNode);
  for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(splitRandom() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!]; }
  const holdoutStarts = candidates.slice(0, Math.min(8, Math.max(candidates.length ? 1 : 0, Math.floor(eligibleStarts.length * .2)))).sort((x, y) => x - y);
  const heldOut = new Set(holdoutStarts), trainingStarts = eligibleStarts.filter(id => !heldOut.has(id));
  interface Experience { node: number; mask: number; edge: CameraViewEdge; reward: number; nextMask: number; done: boolean }
  const model: Experience[] = [], modelIndex = new Map<number, number>();
  let updates = 0, dynaUpdates = 0, absTd = 0;
  const update = (experience: Experience, replay: boolean) => {
    const updateA = random() < .5, own = updateA ? a : b, other = updateA ? b : a, visits = updateA ? visitsA : visitsB;
    const index = qIndex(n, experience.node, experience.mask, experience.edge.to);
    const next = experience.done ? undefined : bestEdge(graph, experience.edge.to, experience.nextMask, own);
    const target = experience.reward + (next ? GAMMA * other[qIndex(n, experience.edge.to, experience.nextMask, next.to)]! : 0);
    const td = target - own[index]!;
    const count = ++visits[index]!;
    own[index] = own[index]! + Math.max(.08, .6 / (1 + .002 * count)) * td;
    updates++; if (replay) dynaUpdates++; absTd += Math.abs(td);
  };
  const curve: CameraTrainingProgress[] = [], interval = Math.max(1, Math.floor(config.episodes / 50));
  let windowReturn = 0, windowEpisodes = 0;
  for (let episode = 1; episode <= config.episodes; episode++) {
    let node = trainingStarts[Math.floor(random() * trainingStarts.length)]!, mask = graph.nodes[node]!.visibleMask & config.goalMask, episodeReturn = 0;
    const epsilon = .06 + .49 * (1 - (episode - 1) / config.episodes);
    for (let step = 0; step < config.maxSteps && mask !== config.goalMask; step++) {
      const edges = graph.edges[node]!; if (!edges.length) break;
      let edge: CameraViewEdge;
      if (random() < epsilon) edge = edges[Math.floor(random() * edges.length)]!;
      else {
        let score = -Infinity; edge = edges[0]!;
        for (const candidate of edges) {
          const index = qIndex(n, node, mask, candidate.to), value = a[index]! + b[index]!;
          if (value > score || (value === score && candidate.to < edge.to)) { score = value; edge = candidate; }
        }
      }
      const result = transition(graph, config, mask, edge);
      const experience = { node, mask, edge, reward: result.reward, nextMask: result.mask, done: result.done };
      const key = qIndex(n, node, mask, edge.to), existing = modelIndex.get(key);
      if (existing === undefined) { modelIndex.set(key, model.length); model.push(experience); } else model[existing] = experience;
      update(experience, false);
      for (let replay = 0; replay < DYNA_REPLAYS; replay++) update(model[Math.floor(random() * model.length)]!, true);
      episodeReturn += result.reward; node = edge.to; mask = result.mask;
    }
    windowReturn += episodeReturn; windowEpisodes++;
    const progress = { episode, episodes: config.episodes, return: windowReturn / windowEpisodes, meanAbsTd: updates ? absTd / updates : 0, epsilon };
    if (episode % interval === 0 || episode === config.episodes) { curve.push(progress); windowReturn = 0; windowEpisodes = 0; }
    onProgress?.(progress);
  }
  const q = Array.from(a, (value, i) => (value + b[i]!) * .5);
  const base = { q, config };
  // A one-node graph has no distinct holdout. Do not relabel training starts
  // as unseen evaluation; empty summaries explicitly retain that limitation.
  const evaluation = { heldOutStarts: holdoutStarts, learned: summarize(holdoutStarts.map(start => rollout(graph, base, start, "learned"))),
    greedy: summarize(holdoutStarts.map(start => rollout(graph, base, start, "greedy"))), random: summarize(holdoutStarts.map(start => rollout(graph, base, start, "random"))) };
  return { version: CAMERA_RL_VERSION, rewardVersion: CAMERA_REWARD_VERSION, fingerprint: graph.fingerprint, graphVersion: graph.version, nodeCount: n, targetCount: graph.targets.length,
    config, q, training: { curve, updates, dynaUpdates, meanAbsTd: updates ? absTd / updates : 0, trainingStarts, holdoutStarts }, evaluation };
}

function validatePolicyCore(graph: CameraViewGraph, value: unknown): asserts value is CameraPolicy {
  requireThat(value && typeof value === "object" && !Array.isArray(value), "Invalid camera policy document.");
  const policy = value as CameraPolicy;
  requireThat(policy.version === CAMERA_RL_VERSION && policy.rewardVersion === CAMERA_REWARD_VERSION && policy.fingerprint === graph.fingerprint && policy.graphVersion === graph.version, "Camera policy version, reward version or scene fingerprint does not match.");
  requireThat(policy.nodeCount === graph.nodes.length && policy.targetCount === graph.targets.length, "Camera policy observation/action dimensions do not match.");
  normalizeConfig(graph, policy.config);
  requireThat(integer(policy.config.maxSteps, 1, 256), "Camera policy is missing its step budget.");
  requireThat(policy.config.priority === "coverage" || policy.config.priority === "steady", "Camera policy is missing its reward priority.");
  requireThat(Array.isArray(policy.q) && policy.q.length === tableSize(graph) && policy.q.length <= MAX_Q && policy.q.every(v => bounded(v, -1000000, 1000000)), "Camera policy Q table has invalid dimensions or values.");
}

/** Strict bounded import. Identity binds a table to the geometry, candidate
 * poses, RGBD features and action graph represented by the graph fingerprint. */
export function validateCameraPolicy(graph: CameraViewGraph, value: unknown): CameraPolicy {
  validateCameraGraph(graph); validatePolicyCore(graph, value);
  const policy = value;
  requireThat(exactKeys(policy, ["version", "rewardVersion", "fingerprint", "graphVersion", "nodeCount", "targetCount", "config", "q", "training", "evaluation"]) && exactKeys(policy.config, ["seed", "episodes", "goalMask", "maxSteps", "priority"]), "Unrecognized camera policy fields.");
  const ids = (input: unknown): input is number[] => Array.isArray(input) && input.length <= MAX_NODES && new Set(input).size === input.length && input.every(id => integer(id, 0, graph.nodes.length - 1));
  const training = policy.training;
  requireThat(exactKeys(training, ["curve", "updates", "dynaUpdates", "meanAbsTd", "trainingStarts", "holdoutStarts"]) && Array.isArray(training.curve) && training.curve.length <= 100 && integer(training.updates, 0, 10000 * 256 * 9) && integer(training.dynaUpdates, 0, training.updates) && training.dynaUpdates * 9 === training.updates * 8 && bounded(training.meanAbsTd, 0, 1000000), "Invalid camera training metrics.");
  requireThat(ids(training.trainingStarts) && training.trainingStarts.length > 0 && ids(training.holdoutStarts) && training.holdoutStarts.length <= 8 && training.trainingStarts.every(id => !training.holdoutStarts.includes(id)), "Invalid camera held-out split.");
  const eligibleStarts = reachableNodes(graph);
  requireThat(training.trainingStarts.length + training.holdoutStarts.length === eligibleStarts.length && [...training.trainingStarts, ...training.holdoutStarts].every(id => eligibleStarts.includes(id)) && training.trainingStarts.includes(graph.startNode), "Incomplete camera held-out split.");
  let previousEpisode = 0;
  for (const point of training.curve) {
    requireThat(exactKeys(point, ["episode", "episodes", "return", "meanAbsTd", "epsilon"]) && integer(point.episode, previousEpisode + 1, policy.config.episodes) && point.episodes === policy.config.episodes && bounded(point.return, -1000000000, 1000000000) && bounded(point.meanAbsTd, 0, 1000000) && bounded(point.epsilon, 0, 1), "Invalid camera training curve.");
    previousEpisode = point.episode;
  }
  requireThat(training.curve.length > 0 && previousEpisode === policy.config.episodes, "Incomplete camera training curve.");
  const evaluation = policy.evaluation;
  requireThat(exactKeys(evaluation, ["heldOutStarts", "learned", "greedy", "random"]) && ids(evaluation.heldOutStarts) && evaluation.heldOutStarts.length === training.holdoutStarts.length && evaluation.heldOutStarts.every((id, i) => id === training.holdoutStarts[i]), "Invalid camera evaluation starts.");
  for (const mode of ["learned", "greedy", "random"] as const) {
    const summary = evaluation[mode];
    requireThat(exactKeys(summary, ["successRate", "meanCoverage", "meanReturn", "meanSteps", "meanDistanceMm", "meanAngleRad", "meanQuality", "rollouts"]) && [summary.successRate, summary.meanCoverage, summary.meanQuality].every(v => bounded(v, 0, 1)) && bounded(summary.meanReturn, -1000000000, 1000000000) && bounded(summary.meanSteps, 0, 256) && bounded(summary.meanDistanceMm, 0, 25600000) && bounded(summary.meanAngleRad, 0, 256 * Math.PI + .001) && Array.isArray(summary.rollouts) && summary.rollouts.length === evaluation.heldOutStarts.length, "Invalid camera evaluation metrics.");
    for (let i = 0; i < summary.rollouts.length; i++) {
      const run = summary.rollouts[i]!;
      requireThat(exactKeys(run, ["startNode", "route", "inspectedMask", "coverage", "success", "steps", "return", "distanceMm", "angleRad", "meanQuality", "termination"]) && run.startNode === evaluation.heldOutStarts[i] && Array.isArray(run.route) && integer(run.route.length, 1, policy.config.maxSteps + 1) && run.route[0] === run.startNode && run.route.every(id => integer(id, 0, graph.nodes.length - 1)) && run.route.slice(1).every((to, j) => graph.edges[run.route[j]!]!.some(edge => edge.to === to)), "Invalid camera evaluation route.");
      requireThat(integer(run.inspectedMask, 0, (1 << graph.targets.length) - 1) && bounded(run.coverage, 0, 1) && typeof run.success === "boolean" && run.steps === run.route.length - 1 && bounded(run.return, -1000000000, 1000000000) && bounded(run.distanceMm, 0, 25600000) && bounded(run.angleRad, 0, 256 * Math.PI + .001) && bounded(run.meanQuality, 0, 1) && ["goal", "step-limit", "dead-end"].includes(run.termination), "Invalid camera evaluation result.");
      const expected = rollout(graph, policy, run.startNode, mode);
      requireThat(["startNode", "inspectedMask", "success", "steps", "termination"].every(key => run[key as keyof CameraRollout] === expected[key as keyof CameraRollout]) && run.route.join(",") === expected.route.join(",") && ["coverage", "return", "distanceMm", "angleRad", "meanQuality"].every(key => Math.abs((run[key as keyof CameraRollout] as number) - (expected[key as keyof CameraRollout] as number)) <= 1e-9), "Camera evaluation does not reproduce its saved policy.");
    }
    const expected = summarize(summary.rollouts);
    requireThat(["successRate", "meanCoverage", "meanReturn", "meanSteps", "meanDistanceMm", "meanAngleRad", "meanQuality"].every(key => Math.abs((summary[key as keyof CameraEvaluationSummary] as number) - (expected[key as keyof CameraEvaluationSummary] as number)) <= 1e-9), "Inconsistent camera evaluation summary.");
  }
  // Return owned arrays so a parsed upload cannot mutate the accepted policy.
  return JSON.parse(JSON.stringify(policy)) as CameraPolicy;
}

export function rolloutCameraPolicy(graph: CameraViewGraph, policy: CameraPolicy, startNode = graph.startNode, mode: CameraPolicyMode = "learned"): CameraRollout {
  validateCameraGraph(graph); validatePolicyCore(graph, policy);
  requireThat(integer(startNode, 0, graph.nodes.length - 1) && ["learned", "greedy", "random"].includes(mode), "Invalid camera rollout start or mode.");
  return rollout(graph, policy, startNode, mode);
}
