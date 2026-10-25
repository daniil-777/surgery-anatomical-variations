import { trainGraspPolicy, type GraspTrainingInput } from "./graspPolicy";
self.onmessage = (event: MessageEvent<{ input: GraspTrainingInput; seed: number }>) => {
  try { self.postMessage({ type: "complete", policy: trainGraspPolicy(event.data.input, event.data.seed, (done, total) => self.postMessage({ type: "progress", done, total })) }); }
  catch (error) { self.postMessage({ type: "error", message: error instanceof Error ? error.message : "Grasp training failed." }); }
};
