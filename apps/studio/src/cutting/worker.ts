import { LiverCuttingSolver } from "./solver";
import type { CuttingOptions, CuttingReference, ScalpelPose } from "./types";

type Request = { id: number } & ({ action: "init"; reference: CuttingReference; options: CuttingOptions }
  | { action: "step"; pose: ScalpelPose } | { action: "reset" });
let solver: LiverCuttingSolver | undefined;
// Worker messages are processed serially. Only completed, accepted mechanical
// states are published; the main thread never mutates the solver's arrays.
self.onmessage = (event: MessageEvent<Request>) => {
  const message = event.data;
  try {
    let accepted = true;
    if (message.action === "init") solver = new LiverCuttingSolver(message.reference, message.options);
    else {
      if (!solver) throw new Error("Cutting worker is not initialized");
      if (message.action === "reset") solver.reset();
      else { solver.setScalpelTarget(message.pose); accepted = solver.step(); }
    }
    const current = solver!, positionsMm = current.positionsMm.slice(), damage = current.damage.slice();
    self.postMessage({ id: message.id, accepted, positionsMm, damage, metrics: current.metrics(),
      pose: current.scalpelPose(), dtSeconds: current.dtSeconds }, { transfer: [positionsMm.buffer, damage.buffer] });
  } catch (error) {
    self.postMessage({ id: message.id, error: error instanceof Error ? error.message : "Cutting worker failed" });
  }
};
