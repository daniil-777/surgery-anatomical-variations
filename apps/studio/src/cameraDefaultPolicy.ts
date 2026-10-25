import { evaluateCameraPolicy, rolloutCameraPolicy, validateCameraGraph, validateCameraPolicy, type CameraPolicy, type CameraViewGraph } from "./cameraRL";
import type { CameraTrainingScene } from "./cameraPlannerScene";

export const DEFAULT_CAMERA_POLICY_URL = "camera-policies/virtamed-survey-v1.json";
export interface DefaultCameraPolicy {
  format: "viscera.pretrained-camera/1";
  graph: CameraViewGraph;
  port: [number, number, number]; fov: number; demonstrationStart: number;
  policy: CameraPolicy;
  provenance: { source: string; sourceSha256: string; learnerSha256: string; weightsSha256: string };
}
const fail = () => new Error("The pretrained policy does not match this anatomy or view. Your edits are preserved. Use Train camera policy to learn a path for this scene.");
const near = (a: number[], b: number[], tolerance = 1e-6) => a.length === b.length && a.every((value, i) => Number.isFinite(value) && Math.abs(value - b[i]!) <= tolerance);

export function readDefaultCameraPolicy(value: unknown): DefaultCameraPolicy {
  const data = value as DefaultCameraPolicy;
  if (!data || data.format !== "viscera.pretrained-camera/1" || !data.provenance
    || ![data.provenance.sourceSha256, data.provenance.learnerSha256, data.provenance.weightsSha256].every(s => typeof s === "string" && /^[a-f0-9]{64}$/.test(s))
    || !Array.isArray(data.port) || data.port.length !== 3 || !data.port.every(Number.isFinite)
    || !Number.isFinite(data.fov) || data.fov < 10 || data.fov > 120) throw new Error("The bundled camera policy is invalid.");
  const policy = validateCameraPolicy(data.graph, data.policy);
  if (!policy.training.updates || !policy.q.some(v => v !== 0) || !policy.training.holdoutStarts.includes(data.demonstrationStart)) throw new Error("The bundled policy has no learned demonstration.");
  const route = rolloutCameraPolicy(data.graph, policy, data.demonstrationStart);
  if (!route.success || route.steps < 2 || route.angleRad < .1) throw new Error("The bundled demonstration cannot complete its inspection.");
  return { ...data, policy };
}

/** Tabular weights transfer only between the SAME anatomy/material signature,
 * pose/action lattice, target identities and inspection masks. Small GPU RGBD
 * differences are tolerated, then all held-out starts are re-evaluated without
 * learning. The fresh guard-built graph, never the saved edges, drives playback. */
export function bindDefaultCameraPolicy(saved: DefaultCameraPolicy, live: CameraTrainingScene): CameraPolicy {
  const a = saved.graph, b = live.graph;
  validateCameraGraph(b);
  if (a.fingerprint.split("-")[0] !== b.fingerprint.split("-")[0] || a.version !== b.version
    || a.nodes.length !== b.nodes.length || a.startNode !== b.startNode
    || JSON.stringify(a.targets) !== JSON.stringify(b.targets) || JSON.stringify(a.observation) !== JSON.stringify(b.observation)
    || Math.abs(saved.fov - live.fov) > 1e-6 || !near(saved.port, live.port)) throw fail();
  for (const [i, view] of a.nodes.entries()) {
    const next = b.nodes[i]!, p = view.pose, q = next.pose;
    if (view.visibleMask !== next.visibleMask || !near(p.position, q.position) || !near(p.direction, q.direction) || !near(p.up, q.up)
      || !near([p.insertionMm, p.yaw, p.pitch], [q.insertionMm, q.yaw, q.pitch])
      || Math.abs(view.clearanceMm - next.clearanceMm) > .05 || next.clearanceMm < 2
      || Math.abs(view.quality - next.quality) > .05) throw fail();
    for (const key of ["depthP10", "depthMedian", "depthP90"] as const) if (Math.abs(view.features[key] - next.features[key]) > .5) throw fail();
    for (const key of ["luminance", "contrast", "glare", "dark", "validDepth", "nearFraction", "sharpness"] as const) if (Math.abs(view.features[key] - next.features[key]) > .05) throw fail();
    const edges = a.edges[i]!, fresh = b.edges[i]!;
    if (edges.length !== fresh.length || edges.some(edge => !fresh.some(e => e.to === edge.to && Math.abs(e.distanceMm - edge.distanceMm) < 1e-6 && Math.abs(e.angleRad - edge.angleRad) < 1e-6))) throw fail();
  }
  const policy = evaluateCameraPolicy(b, { ...saved.policy, fingerprint: b.fingerprint });
  if (policy.evaluation.learned.successRate < 1 || !rolloutCameraPolicy(b, policy, saved.demonstrationStart).success) throw fail();
  return policy;
}
