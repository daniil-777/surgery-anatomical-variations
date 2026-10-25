import { trainCameraPolicy, type CameraViewGraph, type CameraRLConfig } from "./cameraRL";
// Training has no access to the renderer or camera. Terminating this Worker is
// a hard cancellation boundary; no stale job can later publish a policy.
self.onmessage = (event: MessageEvent<{ graph: CameraViewGraph; config: CameraRLConfig }>) => {
  const began = performance.now();
  try {
    const policy = trainCameraPolicy(event.data.graph, event.data.config, progress => {
      if (progress.episode % Math.max(1, Math.floor(progress.episodes / 30)) === 0) self.postMessage({ type: "progress", progress });
    });
    self.postMessage({ type: "complete", policy, trainingMs: performance.now() - began });
  } catch (error) { self.postMessage({ type: "error", message: error instanceof Error ? error.message : "Camera training failed." }); }
};
