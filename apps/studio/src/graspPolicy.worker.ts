import { trainGraspPolicy, revalidateGraspPolicy, type GraspPolicy, type GraspTrainingInput } from "./graspPolicy";
import saved from "./graspDefaultPolicy.json";
self.onmessage = (event: MessageEvent<{ input: GraspTrainingInput; seed: number }>) => {
  try {
    let policy: GraspPolicy;
    const progress = (done: number, total: number) => self.postMessage({ type: "progress", done, total });
    try { policy = revalidateGraspPolicy(event.data.input, saved.policy as GraspPolicy, progress); }
    catch {
      self.postMessage({ type: "learning" });
      policy = trainGraspPolicy(event.data.input, event.data.seed, progress);
    }
    self.postMessage({ type: "complete", policy });
  }
  catch (error) { self.postMessage({ type: "error", message: error instanceof Error ? error.message : "Grasp training failed." }); }
};
