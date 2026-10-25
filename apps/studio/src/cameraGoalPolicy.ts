import type { CameraTrainingScene } from "./cameraPlannerScene";
import { rolloutCameraPolicy, validateCameraGraph, type CameraPolicy } from "./cameraRL";

/** A goal is an observable inspection POSE, not merely an organ appearing
 * anywhere in the image. Relabel the same guarded transition graph for g. */
export function conditionCameraGoal(scene: CameraTrainingScene, organ: string): CameraTrainingScene {
  validateCameraGraph(scene.graph);
  const target = scene.graph.targets.findIndex(t => t.id === organ);
  if (target < 0 || !scene.targetCenterErrors || !scene.targetDepths) throw new Error("Target RGBD observations are unavailable.");
  const pixels = scene.graph.observation.width * scene.graph.observation.height;
  const desiredArea = organ === "liver" ? .45 : .22;
  const scores = scene.graph.nodes.map((node, i) => {
    const area = (scene.targetPixels[i]?.[target] ?? 0) / pixels;
    const center = scene.targetCenterErrors![i]?.[target] ?? 1, depth = scene.targetDepths![i]?.[target] ?? 0;
    if (!Number.isFinite(area + center + depth) || area < .008 || area > .9 || center > .55 || depth < 30 || node.clearanceMm < 10) return 0;
    const framing = Math.exp(-Math.abs(Math.log(area / desiredArea)));
    const distance = Math.exp(-Math.abs(depth - 65) / 95);
    return .35 * Math.max(0, 1 - center) + .25 * framing + .30 * distance + .10 * node.quality;
  });
  let goal = scores.reduce((best, value, i) => value > scores[best]! ? i : best, 0);
  if (scores[goal]! < .4) throw new Error("No clear inspection view of this organ is reachable from the current scope pivot. Move to another operative view and try again.");
  // Avoid gratuitous motion when the current pose is already essentially best.
  if (scores[scene.graph.startNode]! >= scores[goal]! - .015) goal = scene.graph.startNode;
  const label = scene.graph.targets[target]!.label;
  return { ...scene, goal: { id: organ, label, node: goal, score: scores[goal]!, initialScore: scores[scene.graph.startNode]!,
    areaFraction: scene.targetPixels[goal]![target]! / pixels, centerError: scene.targetCenterErrors[goal]![target]!, depthMm: scene.targetDepths[goal]![target]! },
    graph: { ...scene.graph, version: `${scene.graph.version}/goal/1`, fingerprint: `${scene.graph.fingerprint}:goal:${organ}:${goal}`,
      targets: [{ id: `approach:${organ}`, label: `${label} inspection view` }],
      nodes: scene.graph.nodes.map((node, i) => ({ ...node, visibleMask: i === goal ? 1 : 0, quality: scores[i]! })),
    } };
}

/** Full finite-map audit in addition to reserved-start evaluation. Dijkstra is
 * a validation baseline only: its route is never substituted for RL actions. */
export function assessCameraGoal(scene: CameraTrainingScene, policy: CameraPolicy) {
  if (!scene.goal) throw new Error("An organ-conditioned map is required.");
  // Images stay in the study. Their validated features are sufficient for
  // repeated inference, avoiding 45 repeated full-image validation scans.
  const graph = { ...scene.graph, nodes: scene.graph.nodes.map(({ rgb: _rgb, depth: _depth, ...node }) => node) };
  const distance = graph.nodes.map(() => Infinity), visited = new Set<number>(); distance[scene.goal.node] = 0;
  while (visited.size < graph.nodes.length) {
    let next = -1; for (let i = 0; i < distance.length; i++) if (!visited.has(i) && (next < 0 || distance[i]! < distance[next]!)) next = i;
    if (next < 0 || !Number.isFinite(distance[next])) break;
    visited.add(next);
    graph.edges.forEach((edges, from) => { for (const edge of edges) if (edge.to === next) distance[from] = Math.min(distance[from]!, distance[next]! + edge.distanceMm); });
  }
  const runs = graph.nodes.map(node => rolloutCameraPolicy(graph, policy, node.id));
  const stretch = runs.map((run, i) => distance[i]! > .001 ? run.distanceMm / distance[i]! : 1);
  const successRate = runs.filter(run => run.success).length / runs.length, maxStretch = Math.max(...stretch);
  return { starts: runs.length, successRate, maxStretch, meanStretch: stretch.reduce((sum, v) => sum + v, 0) / stretch.length,
    accepted: successRate === 1 && Number.isFinite(maxStretch) && maxStretch <= 1.8 };
}
