import { VisualTaskLab } from "./VisualTaskLab";
import { visualSceneSignature } from "./visualPolicy";
import { useEffect, useRef, useState, type RefObject } from "react";
import { BrainCircuit, Download, Play, Pause, Route, ScanEye, Square, Upload, X } from "lucide-react";
import type { WholeSceneViewportHandle } from "./WholeSceneViewport";
import type { CameraTrainingScene, CameraPlannerState } from "./cameraPlannerScene";
import { rolloutCameraPolicy, validateCameraPolicy, CAMERA_REWARD_WEIGHTS, type CameraPolicy, type CameraPolicyMode, type CameraRollout, type CameraTrainingProgress } from "./cameraRL";
import { bindDefaultCameraPolicy, readDefaultCameraPolicy, DEFAULT_CAMERA_POLICY_URL, type DefaultCameraPolicy } from "./cameraDefaultPolicy";
import { publicUrl } from "./api";
import { conditionCameraGoal, assessCameraGoal } from "./cameraGoalPolicy";
import type { AutomaticGraspState } from "./automaticGrasp";
import "./cameraPlanningLab.css";

const tasks = [
  { id: "hepatobiliary", label: "Hepatobiliary survey", targets: ["liver", "gallbladder", "cystic-duct", "hepatic-duct", "cystic-artery"] },
  { id: "gallbladder", label: "Gallbladder approach", targets: ["gallbladder", "cystic-duct", "hepatic-duct"] },
  { id: "bowel", label: "Bowel overview", targets: ["colon", "small-intestine", "duodenum"] },
];
function save(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: "application/json" })), a = document.createElement("a");
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Observation({ scene, node }: { scene: CameraTrainingScene; node: number }) {
  const rgb = useRef<HTMLCanvasElement>(null), depth = useRef<HTMLCanvasElement>(null), observation = scene.graph.nodes[node]!;
  useEffect(() => {
    const { width, height } = scene.graph.observation;
    for (const [canvas, kind] of [[rgb.current, "rgb"], [depth.current, "depth"]] as const) {
      if (!canvas) continue; canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d"); if (!context) continue;
      const pixels = context.createImageData(width, height);
      for (let i = 0; i < width * height; i++) {
        if (kind === "rgb") pixels.data.set(observation.rgb?.slice(i * 3, i * 3 + 3) ?? [0, 0, 0], i * 4);
        else { const d = observation.depth?.[i] ?? 0, t = Math.min(1, d / 250); pixels.data.set(d ? [25 + 200 * t, 200 - 110 * t, 220 - 170 * t] : [0, 0, 0], i * 4); }
        pixels.data[i * 4 + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
    }
  }, [scene, node, observation]);
  return <div className="camera-rgbd"><figure><canvas ref={rgb} aria-label="Captured RGB observation" /><figcaption>Rendered RGB</figcaption></figure><figure><canvas ref={depth} aria-label="Captured depth observation" /><figcaption>Depth · 0–250 mm</figcaption></figure></div>;
}
function Curve({ policy }: { policy: CameraPolicy }) {
  const values = policy.training.curve.map(p => p.return), min = Math.min(-1, ...values), max = Math.max(1, ...values);
  return <svg className="camera-learning-curve" viewBox="0 0 280 65" role="img" aria-label="Training episode return curve"><line x1="0" x2="280" y1="60" y2="60" stroke="#48635f" /><polyline fill="none" stroke="#a7e8cc" strokeWidth="2" points={values.map((v, i) => `${i / Math.max(1, values.length - 1) * 280},${59 - (v - min) / (max - min) * 54}`).join(" ")} /></svg>;
}

export function CameraPlanningLab({ viewport, ready, disabled, planner, onPrepare, onFreeze, onPrepareGoal, onPrepareGrasp, automaticGrasp }: {
  viewport: RefObject<WholeSceneViewportHandle | null>; ready: boolean; disabled: boolean; planner: CameraPlannerState | null;
  onPrepare: () => void; onFreeze: () => void; onPrepareGoal: () => void;
  onPrepareGrasp: (signal: AbortSignal) => Promise<void>; automaticGrasp: AutomaticGraspState | null;
}) {
  const [open, setOpen] = useState(false), [task, setTask] = useState("hepatobiliary"), [seed, setSeed] = useState("42"), [episodes, setEpisodes] = useState(3000);
  const [priority, setPriority] = useState<"coverage" | "steady">("coverage"), [phase, setPhase] = useState("idle"), [message, setMessage] = useState("");
  const [scene, setScene] = useState<CameraTrainingScene | null>(null), [policy, setPolicy] = useState<CameraPolicy | null>(null);
  const [progress, setProgress] = useState<CameraTrainingProgress | null>(null), [node, setNode] = useState(0), [mode, setMode] = useState<CameraPolicyMode>("learned");
  const [rollout, setRollout] = useState<CameraRollout | null>(null), [trainingMs, setTrainingMs] = useState(0), [inferenceMs, setInferenceMs] = useState(0);
  const [defaultPolicy, setDefaultPolicy] = useState<DefaultCameraPolicy | null>(null), [defaultError, setDefaultError] = useState(""), [reloadDefault, setReloadDefault] = useState(0);
  const [continuous, setContinuous] = useState(true), [origin, setOrigin] = useState<"trained" | "pretrained" | "imported" | "goal">("trained"), [replayStart, setReplayStart] = useState(0);
  const [goalAudit, setGoalAudit] = useState<ReturnType<typeof assessCameraGoal> | null>(null), [jobEpisodes, setJobEpisodes] = useState(3000);
  const [visualActive, setVisualActive] = useState(false);
  const [taskActive, setTaskActive] = useState(false), taskAbort = useRef<AbortController | null>(null);
  const activeWorker = useRef<Worker | null>(null), captureAbort = useRef<AbortController | null>(null), generation = useRef(0), input = useRef<HTMLInputElement>(null);
  const pendingRevision = useRef<number | null>(null), latestScene = useRef(scene); latestScene.current = scene;
  const busy = phase === "capturing" || phase === "training" || visualActive, stale = Boolean(scene && planner && scene.revision !== planner.revision);
  const playing = planner?.phase === "playing" || planner?.phase === "paused";
  useEffect(() => {
    const controller = new AbortController(); setDefaultError("");
    void fetch(publicUrl(DEFAULT_CAMERA_POLICY_URL), { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("The pretrained camera weights could not be loaded.");
      const value = readDefaultCameraPolicy(await response.json());
      if (!controller.signal.aborted) setDefaultPolicy(value);
    }).catch(error => { if (!controller.signal.aborted) setDefaultError(error instanceof Error ? error.message : "Pretrained policy unavailable."); });
    return () => controller.abort();
  }, [reloadDefault]);
  const cancel = () => {
    taskAbort.current?.abort(); taskAbort.current = null; viewport.current?.stopAutomaticGrasp(); setTaskActive(false);
    ++generation.current; pendingRevision.current = null; captureAbort.current?.abort(); captureAbort.current = null; activeWorker.current?.terminate(); activeWorker.current = null;
    viewport.current?.stopCameraPath(); setPhase("idle"); setProgress(null); setMessage("Operation cancelled. A completed prior policy remains available if its scene still matches.");
  };
  useEffect(() => () => { ++generation.current; taskAbort.current?.abort(); captureAbort.current?.abort(); activeWorker.current?.terminate(); viewport.current?.stopCameraPath(); }, [viewport]);
  useEffect(() => { if (busy && pendingRevision.current !== null && planner && planner.revision !== pendingRevision.current) { ++generation.current; taskAbort.current?.abort(); setTaskActive(false); pendingRevision.current = null; captureAbort.current?.abort(); captureAbort.current = null; activeWorker.current?.terminate(); activeWorker.current = null; setPhase("idle"); setMessage("The scene changed. Capture and train a fresh map."); } }, [planner?.revision, busy]);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.code === "Escape" && (busy || taskActive)) { event.preventDefault(); cancel(); } }; window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape); });
  useEffect(() => {
    const diagnostics = window as unknown as { __visceraCameraLabSnapshot?: () => unknown };
    const getter = () => ({ open, phase, message, stale, trainingMs, inferenceMs, planner, progress, origin, replayStart, continuous, goalAudit, goal: scene?.goal, taskActive, automaticGrasp,
      defaultPolicy: defaultPolicy ? { ready: true, episodes: defaultPolicy.policy.config.episodes, updates: defaultPolicy.policy.training.updates, weightsSha256: defaultPolicy.provenance.weightsSha256 } : { ready: false, error: defaultError },
      map: scene ? { fingerprint: scene.graph.fingerprint, revision: scene.revision, nodes: scene.graph.nodes.length, edges: scene.graph.edges.reduce((n, edges) => n + edges.length, 0), captureMs: scene.captureMs, graphMs: scene.graphMs, captureTimesMs: scene.captureTimesMs, blockedEdges: scene.blockedEdges, targets: scene.graph.targets, attainableMask: scene.graph.nodes.reduce((m, n) => m | n.visibleMask, 0), observation: scene.graph.observation } : null,
      policy: policy ? { version: policy.version, config: policy.config, training: policy.training, evaluation: policy.evaluation } : null, rollout });
    diagnostics.__visceraCameraLabSnapshot = getter;
    return () => { if (diagnostics.__visceraCameraLabSnapshot === getter) delete diagnostics.__visceraCameraLabSnapshot; };
  }, [open, phase, message, stale, trainingMs, inferenceMs, planner, progress, scene, policy, rollout, defaultPolicy, defaultError, origin, replayStart, continuous, goalAudit, taskActive, automaticGrasp]);

  async function continueGraspTask(id: number, controller: AbortController, cameraMoved: boolean, parsedSeed: number) {
    try {
      if (cameraMoved) {
        while (true) {
          controller.signal.throwIfAborted(); if (generation.current !== id) return;
          const state = viewport.current!.captureMetadata().cameraPlanner as CameraPlannerState;
          if (state.phase === "complete") break;
          if (!["playing", "paused"].includes(state.phase)) throw new Error("Camera approach interrupted; no grasp was started.");
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        }
      }
      const signature = () => visualSceneSignature(viewport.current!.captureMetadata());
      const arrived = signature();
      setMessage("Inspection view reached. Preparing the grasp skill…");
      await onPrepareGrasp(controller.signal);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      controller.signal.throwIfAborted(); if (generation.current !== id) return;
      if (signature() !== arrived) throw new Error("The scene changed during the task handover. No grasp was started.");
      const result = await viewport.current!.startAutomaticGrasp(controller.signal, parsedSeed);
      if (generation.current === id) setMessage(`${result.message}. Peak simulated reaction ${result.peakForceN.toFixed(3)} N.`);
    } catch (error) { if (generation.current === id) setMessage(error instanceof Error ? error.message : "The automatic task stopped."); }
    finally { if (generation.current === id) { setTaskActive(false); taskAbort.current = null; } }
  }

  async function demonstrate() {
    if (!defaultPolicy || !ready || disabled || busy || playing) return;
    const id = ++generation.current, controller = new AbortController(); captureAbort.current = controller; pendingRevision.current = null;
    setOpen(true); setPhase("capturing"); setMessage(""); setProgress(null); onPrepare();
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (id !== generation.current) return;
      pendingRevision.current = (viewport.current!.captureMetadata().cameraPlanner as CameraPlannerState).revision;
      const nextScene = await viewport.current!.captureCameraMap(defaultPolicy.graph.targets.map(t => t.id), controller.signal);
      if (id !== generation.current) return;
      const began = performance.now(), nextPolicy = bindDefaultCameraPolicy(defaultPolicy, nextScene);
      const nextRollout = rolloutCameraPolicy(nextScene.graph, nextPolicy, defaultPolicy.demonstrationStart);
      setInferenceMs(performance.now() - began); setTrainingMs(0); setScene(nextScene); setPolicy(nextPolicy); setRollout(nextRollout);
      setReplayStart(defaultPolicy.demonstrationStart); setOrigin("pretrained"); setGoalAudit(null); setNode(defaultPolicy.demonstrationStart); setMode("learned"); setTask("hepatobiliary"); setPhase("ready");
      viewport.current!.playCameraPath(nextScene, nextRollout.route, { loop: continuous });
      setMessage("Pretrained weights loaded. Fresh RGBD and collision checks passed; no new training was needed.");
      // On narrow screens the controls are below the scene: bring the moving
      // first-person view (with its own stop controls) back into view.
      if (window.matchMedia("(max-width: 760px)").matches) document.querySelector(".whole-stage")?.scrollIntoView({ block: "start", behavior: "smooth" });
    } catch (error) { if (id === generation.current) { setPhase("idle"); setMessage(error instanceof Error ? error.message : "The demonstration could not start."); } }
    finally { if (id === generation.current) { pendingRevision.current = null; captureAbort.current = null; } }
  }

  async function train(organ?: string, graspAfter = false) {
    if (!ready || disabled || busy || taskActive) return;
    const parsed = Number(seed);
    if (!/^\d+$/.test(seed) || !Number.isSafeInteger(parsed) || parsed > 4294967295) { setMessage("Use a whole-number training seed from 0 to 4,294,967,295."); return; }
    pendingRevision.current = null;
    const id = ++generation.current, controller = new AbortController(); captureAbort.current = controller;
    if (graspAfter) { taskAbort.current = controller; setTaskActive(true); }
    setPhase("capturing"); setMessage(""); setProgress(null); setJobEpisodes(organ ? 10000 : episodes);
    if (organ) { viewport.current?.stopCameraPath(); onPrepareGoal(); } else onFreeze();
    try {
      // Allow React to commit paused motion/material state before freezing a map.
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (id !== generation.current) return;
      pendingRevision.current = (viewport.current!.captureMetadata().cameraPlanner as CameraPlannerState).revision;
      const captured = await viewport.current!.captureCameraMap(organ ? [organ] : tasks.find(t => t.id === task)!.targets, controller.signal, organ ? { approachTarget: organ } : undefined);
      const nextScene = organ ? conditionCameraGoal(captured, organ) : captured;
      if (id !== generation.current) return;
      captureAbort.current = null;
      const goalMask = nextScene.graph.nodes.reduce((mask, view) => mask | view.visibleMask, 0);
      if (!goalMask) throw new Error("No landmark is well framed from this scope map. Aim closer to a visible organ, then capture again.");
      setPhase("training");
      const worker = new Worker(new URL("./cameraRL.worker.ts", import.meta.url), { type: "module" }); activeWorker.current = worker;
      worker.onerror = event => { if (id === generation.current) { pendingRevision.current = null; setTaskActive(false); setPhase("idle"); setMessage(event.message || "The camera training worker could not start."); worker.terminate(); activeWorker.current = null; } };
      worker.onmessage = (event: MessageEvent) => {
        if (id !== generation.current) return;
        if (event.data.type === "progress") setProgress(event.data.progress as CameraTrainingProgress);
        if (event.data.type === "error") { pendingRevision.current = null; setTaskActive(false); setPhase("idle"); setMessage(event.data.message); worker.terminate(); activeWorker.current = null; }
        if (event.data.type === "complete") {
          try {
            const nextPolicy = validateCameraPolicy(nextScene.graph, event.data.policy);
            const audit = organ ? assessCameraGoal(nextScene, nextPolicy) : null;
            if (audit && !audit.accepted) throw new Error("The learned organ path did not pass all-start arrival and route-efficiency checks. Adjust the camera view and train again.");
            const began = performance.now(), nextRollout = rolloutCameraPolicy(nextScene.graph, nextPolicy);
            setInferenceMs(performance.now() - began); setTrainingMs(event.data.trainingMs); setScene(nextScene); setPolicy(nextPolicy); setRollout(nextRollout); setNode(0); setMode("learned"); setPhase("ready");
            setOrigin(organ ? "goal" : "trained"); setGoalAudit(audit); setReplayStart(0);
            setMessage(nextPolicy.training.updates ? "Policy trained and evaluated on reserved starting viewpoints. Inspect the comparisons before replay." : "The selected reachable landmarks are already framed at every start. No motion learning was needed; choose another view or task for a movement exercise.");
            if (organ) {
              if (nextRollout.steps) {
                viewport.current!.playCameraPath(nextScene, nextRollout.route);
                if (window.matchMedia("(max-width: 760px)").matches) document.querySelector(".whole-stage")?.scrollIntoView({ block: "start", behavior: "smooth" });
              }
              setMessage(nextRollout.steps ? `Going to ${nextScene.goal!.label}. Learned with 10,000 episodes; all ${audit!.starts} starting viewpoints pass arrival checks.` : `${nextScene.goal!.label} is already well framed at this scope position.`);
              if (graspAfter) void continueGraspTask(id, controller, nextRollout.steps > 0, parsed);
            }
          } catch (error) { setTaskActive(false); setPhase("idle"); setMessage(error instanceof Error ? error.message : "The policy failed validation."); }
          finally { pendingRevision.current = null; worker.terminate(); activeWorker.current = null; }
        }
      };
      // Pixel images remain in the lab/export; worker receives their shared
      // feature contract and view identities, avoiding repeated image copies.
      worker.postMessage({ graph: { ...nextScene.graph, nodes: nextScene.graph.nodes.map(({ rgb: _rgb, depth: _depth, ...view }) => view) }, config: { seed: parsed, episodes: organ ? 10000 : episodes, goalMask, priority: organ ? "steady" : priority } });
    } catch (error) { if (id === generation.current) { pendingRevision.current = null; captureAbort.current = null; setTaskActive(false); setPhase("idle"); setMessage(error instanceof Error ? error.message : "Camera training failed."); } }
  }
  function replay() {
    if (!scene || !policy || stale || busy) return;
    try { ++generation.current; onFreeze(); const began = performance.now(), result = rolloutCameraPolicy(scene.graph, policy, replayStart, mode); setInferenceMs(performance.now() - began); setRollout(result); viewport.current!.playCameraPath(scene, result.route, { loop: origin === "pretrained" && continuous }); }
    catch (error) { setMessage(error instanceof Error ? error.message : "The path could not start."); }
  }
  async function importPolicy(file?: File) {
    if (!file || !scene || stale || busy || playing) return;
    const id = ++generation.current, fingerprint = scene.graph.fingerprint, revision = scene.revision;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("Policy files must be smaller than 8 MiB.");
      const contents = await file.text();
      if (id !== generation.current || latestScene.current?.graph.fingerprint !== fingerprint || (viewport.current?.captureMetadata().cameraPlanner as CameraPlannerState | undefined)?.revision !== revision || activeWorker.current || captureAbort.current) return;
      const value = JSON.parse(contents), next = validateCameraPolicy(scene.graph, value.policy ?? value);
      setPolicy(next); setRollout(rolloutCameraPolicy(scene.graph, next)); setOrigin("imported"); setGoalAudit(null); setReplayStart(0); setPhase("ready"); setMessage("Imported policy matches this captured scene and passed validation.");
    } catch (error) { if (id === generation.current) setMessage(error instanceof Error ? error.message : "Policy import failed."); }
  }
  const trainedPriority = policy?.config.priority ?? priority, weights = CAMERA_REWARD_WEIGHTS[trainedPriority];
  return <section className={`camera-planning-lab ${open ? "is-open" : ""}`} aria-label="Camera planning lab">
    <button type="button" className="camera-lab-launch" aria-expanded={open} disabled={!ready || disabled} onClick={() => setOpen(value => !value)}><span className="camera-lab-icon"><ScanEye size={22} /></span><span><strong>Camera planning lab</strong><small>Train scope paths with RGB + depth</small></span><BrainCircuit size={18} /></button>
    <div className="camera-default-card">
      <span className="camera-default-badge">{defaultPolicy ? "PRETRAINED / READY" : defaultError ? "WEIGHTS UNAVAILABLE" : "LOADING LEARNED WEIGHTS"}</span>
      <p>{defaultPolicy ? `${defaultPolicy.policy.config.episodes.toLocaleString()} training episodes · fixed-pivot scope motion` : defaultError || "Loading the saved inspection policy…"}</p>
      <button className="camera-default-start" disabled={!ready || disabled || busy || taskActive || playing || !defaultPolicy} onClick={() => void demonstrate()}><Play size={16} />Start camera demonstration</button>
      {defaultError && <button onClick={() => setReloadDefault(value => value + 1)}>Retry loading weights</button>}
      <label className="camera-loop-toggle"><input type="checkbox" checked={continuous} disabled={busy || taskActive || playing} onChange={event => setContinuous(event.target.checked)} />Continuous inspection loop</label>
      <small>Learned inspection + guarded return. Runs until you stop it.</small>
      <div className="camera-goal-actions" aria-label="Organ camera destinations"><button disabled={!ready || disabled || busy || taskActive} onClick={() => { setOpen(true); void train("liver"); }}><Route size={14} />Go to liver</button><button disabled={!ready || disabled || busy || taskActive} onClick={() => { setOpen(true); void train("gallbladder"); }}><Route size={14} />Go to gallbladder</button></div>
      <small>Learn an approach from your current position, then hold the organ view.</small>
      <div className="camera-grasp-task" aria-label="Automatic liver task">
        <span className="camera-default-badge">CAMERA + INSTRUMENT</span>
        <button className="camera-default-start" disabled={!ready || disabled || busy || taskActive} onClick={() => { setOpen(true); void train("liver", true); }}><Play size={16} />Approach & grasp liver</button>
        <small>Approach · close · gentle lift · hold · release. Learns a grasp option using the scene’s tissue response.</small>
        {taskActive && <button className="camera-task-stop" onClick={cancel}><Square size={14} />Stop automatic task</button>}
        {automaticGrasp?.policy && <small>{automaticGrasp.policy.episodes} physics rollouts · {automaticGrasp.policy.evaluation.filter(e => e.success).length}/3 local robustness checks · peak {automaticGrasp.peakForceN.toFixed(3)} N</small>}
        {automaticGrasp && automaticGrasp.phase !== "idle" && <p role="status">{automaticGrasp.message}{automaticGrasp.phase === "learning" ? ` · ${automaticGrasp.progress}/${automaticGrasp.total}` : ""}</p>}
        {automaticGrasp?.policy && !taskActive && <button onClick={() => save({ format: "viscera.automatic-liver-study/1", camera: { scene, policy, rollout }, grasp: automaticGrasp }, "viscera-liver-task.json")}><Download size={14} />Export task study</button>}
      </div>
    </div>
    <VisualTaskLab viewport={viewport} disabled={!ready || disabled || phase === "capturing" || phase === "training" || taskActive || playing} prepare={onPrepare} prepareGrasp={onPrepareGrasp} onActive={setVisualActive} cancelToken={generation.current} />
    {open && <div className="camera-lab-content">
      <div className="camera-lab-title"><span>RL / VIRTUAL SCOPE PRACTICE</span><button aria-label="Close camera planning lab" onClick={() => { cancel(); setOpen(false); }}><X size={16} /></button></div>
      <p>Practice camera-system planning around visible anatomy. The virtual 0° scope pivots about one inferred entry point and keeps a level horizon.</p>
      <button disabled={busy || taskActive || disabled} onClick={onPrepare}><ScanEye size={15} />Use operative camera</button>
      <label>Inspection task<select aria-label="Camera inspection task" value={task} disabled={busy || taskActive || playing} onChange={e => setTask(e.target.value)}>{tasks.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
      <div className="camera-lab-pair"><label>Seed<input aria-label="Camera training seed" inputMode="numeric" value={seed} disabled={busy || taskActive} onChange={e => setSeed(e.target.value)} /></label><label>Episodes<select aria-label="Camera training episodes" value={episodes} disabled={busy || taskActive} onChange={e => setEpisodes(Number(e.target.value))}>{[1000, 3000, 6000].map(n => <option key={n}>{n}</option>)}</select></label></div>
      <label>Reward priority<select aria-label="Camera reward priority" value={priority} disabled={busy || taskActive} onChange={e => setPriority(e.target.value as typeof priority)}><option value="coverage">Inspect landmarks</option><option value="steady">Steady scope motion</option></select></label>
      <div className="camera-lab-actions"><button className="camera-train" disabled={busy || taskActive || disabled || playing} onClick={() => void train()}><BrainCircuit size={16} />{busy ? phase === "capturing" ? "Capturing RGBD…" : "Learning policy…" : "Train camera policy"}</button>{busy && <button onClick={cancel}><Square size={14} />Cancel training</button>}</div>
      {busy && <progress aria-label="Camera training progress" max={phase === "capturing" ? planner?.total ?? 27 : jobEpisodes} value={phase === "capturing" ? planner?.captured ?? 0 : progress?.episode ?? 0} />}
      <p role="status" className={stale ? "camera-lab-stale" : ""}>{busy ? (phase === "capturing" ? planner?.message : "Learning and evaluating the camera policy…") : stale && phase === "ready" ? "Scene changed — recapture before using this policy." : message || planner?.message || "Prepare the operative camera, then train a policy."}</p>
      {scene && policy && <>
        {scene.goal && <p>Target: {scene.goal.label} · planned working depth {scene.goal.depthMm.toFixed(0)} mm · target fills {Math.round(scene.goal.areaFraction * 100)}% of the image. {goalAudit && `${goalAudit.starts} / ${goalAudit.starts} starting views reach the goal; longest route ${(goalAudit.maxStretch).toFixed(2)}× the shortest-distance baseline.`}</p>}
        <div className="camera-lab-metrics"><span><strong>{scene.graph.nodes.length}</strong> RGBD views</span><span><strong>{origin === "pretrained" ? "Loaded" : `${(trainingMs / 1000).toFixed(2)}s`}</strong>{origin === "pretrained" ? "pretrained weights" : "worker training"}</span><span><strong>{inferenceMs.toFixed(1)}ms</strong> route inference</span></div>
        <label>Observation view<select aria-label="Camera observation view" value={node} onChange={e => setNode(Number(e.target.value))}>{scene.graph.nodes.map(view => <option key={view.id} value={view.id}>View {view.id + 1} · depth {view.features.depthMedian.toFixed(0)} mm</option>)}</select></label>
        <Observation scene={scene} node={node} />
        <div className="camera-targets" aria-label="Camera landmark coverage">{scene.graph.targets.map((target, i) => <span key={target.id} className={(policy.config.goalMask & 1 << i) ? "reachable" : "unavailable"}>{(policy.config.goalMask & 1 << i) ? "●" : "○"} {target.label}{!(policy.config.goalMask & 1 << i) && " · not well framed"}</span>)}</div>
        <Curve policy={policy} />
        <p className="camera-lab-caption">Reserved starting viewpoints · same captured anatomy</p>
        <table><thead><tr><th>Policy</th><th>Success</th><th>Travel</th><th>Return</th></tr></thead><tbody>{([['learned','Learned RL'],['greedy','Greedy view'],['random','Random']] as const).map(([key,label]) => <tr key={key}><th>{label}</th><td>{Math.round(policy.evaluation[key].successRate * 100)}%</td><td>{policy.evaluation[key].meanDistanceMm.toFixed(0)} mm</td><td>{policy.evaluation[key].meanReturn.toFixed(1)}</td></tr>)}</tbody></table>
        <label>Replay policy<select aria-label="Camera replay policy" value={mode} disabled={playing} onChange={e => setMode(e.target.value as CameraPolicyMode)}><option value="learned">Learned RL</option><option value="greedy">Greedy baseline</option><option value="random">Seeded random baseline</option></select></label>
        <div className="camera-lab-actions"><button disabled={stale || busy || taskActive || disabled || playing} onClick={replay}><Play size={15} />Replay camera path</button>{playing && <><button onClick={() => viewport.current?.pauseCameraPath()}><Pause size={14} />{planner?.phase === "paused" ? "Resume path" : "Pause path"}</button><button onClick={() => viewport.current?.stopCameraPath()}><Square size={14} />Stop path</button></>}</div>
        {rollout && <p>{rollout.success ? "Planned route completes the inspection goal" : "Planned route provides partial inspection"} · {rollout.steps} planned {rollout.steps === 1 ? "step" : "steps"} · {rollout.distanceMm.toFixed(0)} mm · {Math.round(rollout.coverage * 100)}% of reachable landmarks.</p>}
        {Boolean(planner?.returnSegments) && <p>Replay includes a guarded return to the captured start: {planner!.returnSegments} extra segments · {planner!.returnDistanceMm.toFixed(0)} mm. Policy metrics above exclude this return.</p>}
        {playing && <p role="status">{planner?.message} · {planner?.segment} / {planner?.segments} segments</p>}
        <div className="camera-lab-actions"><button disabled={busy || stale} onClick={() => save({ format: "viscera.camera-training-study/1", scene, policy, rollout, timing: { trainingMs, inferenceMs } }, "viscera-camera-policy.json")}><Download size={14} />Export study</button><button disabled={busy || taskActive || stale || playing} onClick={() => input.current?.click()}><Upload size={14} />Import policy</button><input ref={input} type="file" accept="application/json,.json" hidden onChange={e => { void importPolicy(e.target.files?.[0]); e.target.value = ""; }} /></div>
      </>}
      <details><summary>Observations, reward & constraints</summary><p>Actual 64 × 48 tissue RGB, linear depth, and landmark IDs from the known 3D map. The policy learns view-to-view actions and remembers inspected landmarks. RGB uses the material render before the HDR glare effect.</p><p>{policy ? `Trained reward: ${trainedPriority === "steady" ? "steady scope motion" : "inspect landmarks"}. ` : ""}Dyna Double Q · eight replay updates per transition. A new centered landmark earns {weights.newTarget}, completion {weights.completion}; each step costs {weights.step}, travel {weights.distance} per mm, rotation {weights.angle} per radian, with image-quality and glare terms.</p><p>The combined liver task uses an authored stage supervisor, the learned camera policy, and UCB grasp-option learning in an isolated copy of the coupled tissue solver. Contact points are selected geometrically; the grasp policy does not interpret pixels or measure jaw pressure. Each edge and every replay movement has a 2 mm virtual lens guard. The entry point is inferred; camera shaft, trocar forces and patient anatomy are not calibrated. Use this simulation lab to compare planning systems; it has no clinical validation.</p></details>
    </div>}
  </section>;
}
