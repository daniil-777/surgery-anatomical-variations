import type { WholeSceneViewportHandle } from "./WholeSceneViewport";
import type { AutomaticGraspState } from "./automaticGrasp";
import type { CameraPlannerState } from "./cameraPlannerScene";
import { conditionCameraGoal, assessCameraGoal } from "./cameraGoalPolicy";
import { rolloutCameraPolicy, validateCameraPolicy, type CameraPolicy } from "./cameraRL";
import { assertSkillTransition, predictVisualSkill, visualSceneSignature, type VisualDecision, type VisualSkill } from "./visualPolicy";

export interface VisualTaskState { phase: string; message: string; decisions: VisualDecision[]; succeeded: boolean; }
export const initialVisualTask = (): VisualTaskState => ({ phase: "idle", message: "", decisions: [], succeeded: false });
export async function waitVisual(predicate: () => boolean, signal: AbortSignal, timeoutMs: number) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    signal.throwIfAborted(); if (performance.now() > deadline) throw new Error("Visual task timed out; instrument released.");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  signal.throwIfAborted();
}
async function approach(viewport: WholeSceneViewportHandle, signal: AbortSignal) {
  const captured = conditionCameraGoal(await viewport.captureCameraMap(["liver"], signal, {approachTarget:"liver"}), "liver");
  signal.throwIfAborted();
  const policy = await new Promise<CameraPolicy>((resolve, reject) => {
    const worker = new Worker(new URL("./cameraRL.worker.ts", import.meta.url), { type: "module" });
    const finish = (error?: Error, value?: CameraPolicy) => { worker.terminate(); clearTimeout(timeout); signal.removeEventListener("abort", abort); error ? reject(error) : resolve(value!); };
    const abort = () => finish(new DOMException("Cancelled", "AbortError"));
    const timeout = setTimeout(() => finish(new Error("Camera learning timed out.")), 60000);
    signal.addEventListener("abort", abort, {once:true});
    worker.onerror = event => finish(new Error(event.message));
    worker.onmessage = event => { if (event.data.type === "complete") finish(undefined, event.data.policy); if (event.data.type === "error") finish(new Error(event.data.message)); };
    worker.postMessage({graph:{...captured.graph,nodes:captured.graph.nodes.map(({rgb:_rgb,depth:_depth,...node})=>node)},config:{seed:42,episodes:10000,goalMask:1,priority:"steady"}});
  });
  signal.throwIfAborted(); validateCameraPolicy(captured.graph, policy);
  if (!assessCameraGoal(captured, policy).accepted) throw new Error("The camera skill failed its route checks.");
  const route = rolloutCameraPolicy(captured.graph, policy);
  if (route.steps) {
    viewport.playCameraPath(captured, route.route);
    await waitVisual(() => {
      const state = viewport.captureMetadata().cameraPlanner as CameraPlannerState;
      if (state.phase === "complete") return true;
      if (state.phase !== "playing") throw new Error("Camera skill interrupted.");
      return false;
    }, signal, 90000);
  }
}
export async function runVisualTask(context: {
  viewport: WholeSceneViewportHandle; signal: AbortSignal; instruction: string; modelId: string;
  prepare: () => void; prepareGrasp: (signal: AbortSignal) => Promise<void>;
  publish: (state: VisualTaskState) => void;
}) {
  const {viewport,signal,publish} = context, state = initialVisualTask();
  let previous: VisualSkill | "none" = "none", grasp: Promise<AutomaticGraspState> | null = null, graspError: unknown;
  const update = (phase: string, message: string) => { state.phase=phase; state.message=message; publish({...state,decisions:[...state.decisions]}); };
  const stop = () => { viewport.stopCameraPath(); viewport.stopAutomaticGrasp(); };
  signal.addEventListener("abort",stop,{once:true});
  try {
    signal.throwIfAborted(); context.prepare();
    await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
    for (let step=0;step<4;step++) {
      signal.throwIfAborted(); update("thinking", "Reading the surgical view and choosing the next skill…");
      const observation=viewport.captureVisualObservation(previous);
      const decision=await predictVisualSkill(observation,context.instruction,signal);
      if (decision.modelId !== context.modelId) throw new Error("The connected model changed; reconnect before running a new task.");
      if (visualSceneSignature(viewport.captureMetadata()) !== observation.sceneSignature) throw new Error("Scene or camera changed during inference; prediction discarded.");
      if (graspError) throw graspError;
      assertSkillTransition(previous,decision.skill); state.decisions.push(decision);
      if (decision.skill === "look") {
        update("look","Visual policy chose: look at liver. Checking and following the camera route…"); await approach(viewport,signal);
      } else if (decision.skill === "grasp") {
        update("grasp","Visual policy chose: grasp gently. Checking tissue response and instrument clearance…");
        const signature=visualSceneSignature(viewport.captureMetadata());
        await context.prepareGrasp(signal); await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))); signal.throwIfAborted();
        if (visualSceneSignature(viewport.captureMetadata())!==signature) throw new Error("Scene changed before grasping.");
        grasp=viewport.startAutomaticGrasp(signal,42,true); void grasp.catch(error=>{graspError=error;});
        await waitVisual(()=>{if(graspError)throw graspError;return (viewport.captureMetadata().automaticGrasp as AutomaticGraspState).phase==="holding";},signal,100000);
      } else if (decision.skill === "release") {
        update("release","Visual policy chose: release. Lowering, opening, withdrawing, and checking recovery…");
        viewport.releaseAutomaticGrasp(); const result=await grasp;
        if (!result?.succeeded) throw new Error("Tissue recovery was not confirmed.");
      } else if (decision.skill === "finish") {
        if (!(viewport.captureMetadata().automaticGrasp as AutomaticGraspState).succeeded) throw new Error("The task has not met completion checks.");
        state.succeeded=true; update("complete","Visual task complete: liver inspected, grasped, and released."); return state;
      }
      previous=decision.skill;
    }
    throw new Error("Visual task exceeded its decision budget.");
  } catch(error) {
    stop(); update(signal.aborted?"stopped":"blocked",error instanceof Error?error.message:"Visual task stopped."); throw error;
  } finally { signal.removeEventListener("abort",stop); }
}
