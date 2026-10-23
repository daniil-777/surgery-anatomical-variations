/** CPU qualification of the prepared liver-cutting experiment.
 * Run with: node node_modules/vite-node/vite-node.mjs scripts/check_cutting_trajectory.ts --help
 * Accepted affine surface validity does not certify swept collision or realism.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {readCuttingReference} from "../apps/studio/src/cutting/reference";
import { CUTTING_NUMERICS } from "../apps/studio/src/cutting/numerics";
import { LiverCuttingSolver, type CuttingMetrics } from "../apps/studio/src/cutting/solver";
import { DEFAULT_SCALPEL, type CuttingReference, type ScalpelPose } from "../apps/studio/src/cutting/types";
import type { ContactQuadrature } from "../apps/studio/src/cutting/contactQuadrature";

const help = `CPU liver-cutting trajectory qualification (run from the viscera directory)

  --reference PATH             Reference JSON; default apps/studio/public/cutting/liver-reference.json
  --equilibrium-model MODEL    stable-neo-hookean or log-neo-hookean; default numerical policy
  --hz NUMBER                  Nominal frequency; default 960 (alternative: --dt-seconds)
  --dt-seconds NUMBER           Maximum requested step duration; mutually exclusive with --hz
  --spacing-mm NUMBER           Contact quadrature spacing; default 2.5
  --depth-mm NUMBER             Entry below actual cap top; default 12
  --sweep-mm NUMBER             Lateral travel; default 24, clipped to cap Z extent
  --speed-mm-s NUMBER           Prescribed travel speed, (0,30]; default 30
  --recoil-seconds NUMBER       Unloaded observation after withdrawal; default 0.35
  --arrival-tolerance-mm NUMBER Phase arrival tolerance; default 0.03 (matches UI workflow)
  --max-wall-seconds NUMBER     Stop incomplete work after this elapsed budget; default 600
  --max-steps NUMBER            Maximum total accepted/requested steps; default 100000
  --output PATH                New receipt directory; default artifacts/cutting-trajectory-TIMESTAMP
  --help                       Print this message without simulating

Writes config.json, progress.json, report.json and accepted-state replay.json.
The replay holds actual accepted snapshots at approximately 30 physical Hz.
No deformation or damage is interpolated. All receipts name source/reference hashes.
Exit 0 requires the ENTIRE requested path, withdrawal and recoil to finish with
the configured solver and complete affine source-cap overlap gates. Swept collision
between accepted instants and biological realism are NOT evaluated.
`;

type Config = {
  equilibriumModel: "stable-neo-hookean"|"log-neo-hookean"; reference: string; dtSeconds: number; spacingMm: number; depthMm: number;
  sweepMm: number; speedMmS: number; recoilSeconds: number; arrivalToleranceMm: number;
  maxWallSeconds: number; maxSteps: number; output: string;
};
function parse(args: string[]): Config | null {
  if (args.includes("--help")) { console.log(help); return null; }
  const allowed = new Set(["reference", "equilibrium-model", "hz", "dt-seconds", "spacing-mm", "depth-mm", "sweep-mm",
    "speed-mm-s", "recoil-seconds", "arrival-tolerance-mm", "max-wall-seconds", "max-steps", "output"]);
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, ""), value = args[i + 1];
    if (!args[i]?.startsWith("--") || !key || !allowed.has(key) || !value || value.startsWith("--")) throw new Error(`Invalid argument ${args[i] ?? ""}; use --help`);
    if (Object.hasOwn(flags, key)) throw new Error(`Duplicate --${key}`);
    flags[key] = value;
  }
  if (flags.hz && flags["dt-seconds"]) throw new Error("Choose --hz or --dt-seconds, not both");
  const number = (key: string, fallback: number) => {
    const value = flags[key] === undefined ? fallback : Number(flags[key]);
    if (!Number.isFinite(value)) throw new Error(`Finite --${key} required`);
    return value;
  };
  const equilibriumModel=flags["equilibrium-model"]??CUTTING_NUMERICS.defaultEquilibriumModel;
  if(equilibriumModel!=="stable-neo-hookean"&&equilibriumModel!=="log-neo-hookean")throw new Error("Unknown equilibrium model");
  const config: Config = {
    equilibriumModel,
    reference: path.resolve(flags.reference ?? "apps/studio/public/cutting/liver-reference.json"),
    dtSeconds: flags["dt-seconds"] ? number("dt-seconds", 0) : 1 / number("hz", 960),
    spacingMm: number("spacing-mm", CUTTING_NUMERICS.defaultContactSpacingMm), depthMm: number("depth-mm", 12),
    sweepMm: number("sweep-mm", 24), speedMmS: number("speed-mm-s", 30),
    recoilSeconds: number("recoil-seconds", .35), arrivalToleranceMm: number("arrival-tolerance-mm", .03),
    maxWallSeconds: number("max-wall-seconds", 600), maxSteps: number("max-steps", 100000),
    output: path.resolve(flags.output ?? `artifacts/cutting-trajectory-${Date.now()}`),
  };
  if (!(config.dtSeconds > 0 && config.dtSeconds <= CUTTING_NUMERICS.maximumStepSeconds)) throw new Error("Step duration must be in (0,1/30] seconds");
  if (!(config.spacingMm > 0 && config.depthMm >= 0 && config.sweepMm >= 0 && config.recoilSeconds >= 0)) throw new Error("Positive spacing and nonnegative trajectory dimensions required");
  if (!(config.speedMmS > 0 && config.speedMmS <= CUTTING_NUMERICS.maximumToolSpeedMmS)) throw new Error("Speed must be in (0,30] mm/s");
  if (!(config.arrivalToleranceMm > 0 && config.arrivalToleranceMm <= .1)) throw new Error("Arrival tolerance must be in (0,0.1] mm");
  if (!(config.maxWallSeconds > 0 && Number.isInteger(config.maxSteps) && config.maxSteps > 0)) throw new Error("Positive wall budget and integer step budget required");
  if (fs.existsSync(config.output) && fs.readdirSync(config.output).length) throw new Error("Output directory must be new or empty; existing receipts are never overwritten");
  return config;
}

const sourcePaths = ["solver.ts", "minimize.ts", "preconditioner.ts", "contactQuadrature.ts", "cohesive.ts", "types.ts", "continuumEvaluator.ts", "numerics.ts", "contactSurface.ts", "contactIntegral.ts", "contactAssembly.ts", "contactIntegralScratch.ts", "reference.ts", "logVolume.ts", "contactCapDomain.ts", "continuumBlocks.ts", "sparseBlockPreconditioner.ts"]
  .map(name => `apps/studio/src/cutting/${name}`).concat("apps/studio/src/liverContinuumMaterial.ts");
const sha = (bytes: crypto.BinaryLike) => crypto.createHash("sha256").update(bytes).digest("hex");
const sources = () => Object.fromEntries(sourcePaths.map(name => {
  try { return [name, sha(fs.readFileSync(name))]; }
  catch { return [name, "UNREADABLE"]; }
}));
type Frame = { timeSeconds: number; nodePositionsMm: number[]; damage: number[]; contactSides: number[]; scalpelPose: ScalpelPose; metrics: CuttingMetrics; phase: string };
type Phase = { name: string; target?: ScalpelPose; durationSeconds?: number };

function run(config: Config): void {
  fs.mkdirSync(config.output, { recursive: true });
  const write = (name: string, data: unknown) => fs.writeFileSync(path.join(config.output, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
  const sourceHashes = sources(), raw = fs.readFileSync(config.reference), referenceSha256 = sha(raw);
  const mesh = readCuttingReference(JSON.parse(raw.toString()));
  const bulk = { young_pa: 4800, poisson: .45, relaxation_fraction: .42, relaxation_time_s: .65,
    density_kg_m3: 1060, contact_stiffness_n_m: 300, indentation_stiffness_n_m: 20000, fracture_energy_j_m2: 20 };
  const cohesive = { fractureEnergyJm2: 2.5, peakTractionPa: 5000 };
  const solver = new LiverCuttingSolver(mesh, { bulk, cohesive, equilibriumModel:config.equilibriumModel, gravity: false, dtSeconds: config.dtSeconds, contactSpacingMm: config.spacingMm });
  // Repository-owned numerical diagnostics, not a public persistence API.
  // Replay alone cannot resume mechanics; the separate internal checkpoint is
  // source-version-bound and retains both independently committed memories.
  type InternalCell = { state: {previous:Float64Array;memory:Float64Array};shifts?:Float64Array };
  const diagnostics = solver as unknown as { contactSides: Int8Array; contactQuadrature: ContactQuadrature;
    positions:Float64Array;velocities:Float64Array;cells:InternalCell[];
    targetPose:ScalpelPose;trialPose:ScalpelPose;continuum:{cells:InternalCell[]} };
  const boundary = mesh.cap?.positionsMm ?? mesh.seamPairs.flatMap(pair => mesh.positionsMm.slice(3 * pair.left, 3 * pair.left + 3));
  let top = -Infinity, entryZ = 0, zmax = -Infinity;
  for (let i = 0; i < boundary.length; i += 3) {
    if (boundary[i + 1]! > top) { top = boundary[i + 1]!; entryZ = boundary[i + 2]!; }
    zmax = Math.max(zmax, boundary[i + 2]!);
  }
  const finalZ = Math.min(entryZ + config.sweepMm, zmax);
  const phases: Phase[] = [
    { name: "position", target: { tipYMm: top + 3, centerZMm: entryZ, active: true } },
    { name: "descend", target: { tipYMm: top - config.depthMm, centerZMm: entryZ, active: true } },
    { name: "sweep", target: { tipYMm: top - config.depthMm, centerZMm: finalZ, active: true } },
    { name: "withdraw", target: { tipYMm: top + 3, centerZMm: finalZ, active: true } },
    { name: "deactivate", target: { tipYMm: top + 3, centerZMm: finalZ, active: false } },
    { name: "recoil", durationSeconds: config.recoilSeconds },
  ];
  const metadata = { config, equilibriumModel: solver.equilibriumModel, finiteStrainCalibrated: false,
    bulk, cohesive, scalpelDimensions: DEFAULT_SCALPEL, sourceHashes, referenceSha256,
    quadratureSamples: diagnostics.contactQuadrature.samples.length, actualLateralTravelMm: finalZ - entryZ,
    numerics: CUTTING_NUMERICS,
    gates: { maximumNodalResidualN: CUTTING_NUMERICS.maximumNodalResidualN,
      maximumSamplePenetrationMm: CUTTING_NUMERICS.maximumPenetrationHalfThicknessFraction * DEFAULT_SCALPEL.halfThicknessMm,
      maximumSurfacePenetrationMm: mesh.cap ? CUTTING_NUMERICS.maximumPenetrationHalfThicknessFraction * DEFAULT_SCALPEL.halfThicknessMm : null,
      minimumAcceptedJacobianExclusive: CUTTING_NUMERICS.minimumAcceptedJacobian,
      acceptedAffineSurfaceCollision: mesh.cap ? "BOUNDED" : "NOT_EVALUATED", sweptCollision: "NOT_EVALUATED", biologicalValidation: "NOT_EVALUATED" },
    timingContext: "Elapsed wall time on this host; concurrent workload is uncontrolled, so this is not an isolated performance benchmark." };
  write("config", metadata);
  const frames: Frame[] = [], events: unknown[] = [], phaseReports: unknown[] = [];
  const started = performance.now(), mass = solver.metrics().totalMassKg;
  let status = "RUNNING", error = "", currentPhase = "initial", requestedSteps = 0, nextFrameTime = 0, lastPersistWall=performance.now();
  let maximumStepWallMs = 0, maximumResidualN = 0, minimumJacobian = 1, maximumVolumeError = 0, maximumSamplePenetrationMm = 0, maximumSurfacePenetrationMm: number | null = mesh.cap ? 0 : null, peakReactionN = 0;
  let previousDamage = solver.damage.slice(), previousDissipation = 0;
  const observe = (forceFrame = false) => {
    const m = solver.metrics();
    if (Object.values(m).some(value => typeof value === "number" && !Number.isFinite(value)) || !m.contactForceN.every(Number.isFinite)) throw new Error("Nonfinite reported mechanics");
    if (Math.abs(m.totalMassKg - mass) > 1e-12 * Math.max(1, mass)) throw new Error("Mass changed");
    solver.damage.forEach((value, i) => { if (value + 1e-12 < previousDamage[i]!) throw new Error("Cohesive damage healed"); });
    if (m.fractureDissipationJ + 1e-12 < previousDissipation) throw new Error("Fracture dissipation decreased");
    previousDamage = solver.damage.slice(); previousDissipation = m.fractureDissipationJ;
    maximumResidualN = Math.max(maximumResidualN, m.stationarityResidualN);
    minimumJacobian = Math.min(minimumJacobian, m.minimumJacobian);
    maximumVolumeError = Math.max(maximumVolumeError, Math.abs(m.volumeRatio - 1));
    maximumSamplePenetrationMm = Math.max(maximumSamplePenetrationMm, m.maximumContactPenetrationMm);
    if(m.maximumSurfacePenetrationMm!==null) maximumSurfacePenetrationMm=Math.max(maximumSurfacePenetrationMm??0,m.maximumSurfacePenetrationMm);
    peakReactionN = Math.max(peakReactionN, Math.hypot(...m.contactForceN));
    if (forceFrame || m.timeSeconds >= nextFrameTime - 1e-10) {
      const frame: Frame = { timeSeconds: m.timeSeconds, nodePositionsMm: Array.from(solver.positionsMm), damage: Array.from(solver.damage),
        contactSides: Array.from(diagnostics.contactSides), scalpelPose: solver.scalpelPose(), metrics: m, phase: currentPhase };
      if (frames.at(-1)?.timeSeconds === m.timeSeconds) frames[frames.length - 1] = frame; else frames.push(frame);
      nextFrameTime = (Math.floor(m.timeSeconds * 30 + 1e-8) + 1) / 30;
    }
  };
  const persist = () => {
    lastPersistWall=performance.now();
    const sourcesAfter = sources(), sourceUnchanged = !Object.values(sourceHashes).includes("UNREADABLE") && JSON.stringify(sourceHashes) === JSON.stringify(sourcesAfter);
    let referenceUnchanged = false;
    try { referenceUnchanged = referenceSha256 === sha(fs.readFileSync(config.reference)); } catch { /* preserve the failure receipt */ }
    if (!sourceUnchanged || !referenceUnchanged) { status = "SOURCE_CHANGED"; error = "Runtime source or reference changed during qualification"; }
    const result = { schema: "viscera.cutting-trajectory-qualification/v1", ...metadata, status, error,
      complete: status === "COMPLETED_CONFIGURED_GATES", sourcesAfter, sourceUnchanged, referenceUnchanged,
      elapsedWallMs: performance.now() - started, requestedSteps, phases: phaseReports,
      maximumStepWallMs, maximumResidualN, minimumJacobian, maximumVolumeError, maximumSamplePenetrationMm, maximumSurfacePenetrationMm, peakReactionN, final: solver.metrics() };
    write("progress", result);
    write("replay", { schema: "viscera.cutting-trajectory/v1", ...metadata, status, complete: result.complete,
      sourceUnchanged, referenceUnchanged, units: { position: "mm", time: "s" }, approxSamplingHz: 30, events, frames });
    const memory=(cells:InternalCell[])=>cells.map(cell=>({previous:Array.from(cell.state.previous),memory:Array.from(cell.state.memory)}));
    write("checkpoint", { schema:"viscera.cutting-internal-checkpoint/v1", ...metadata, status,
      sourceUnchanged,referenceUnchanged,
      scope:"Diagnostic internal state only; restoration requires matching source/reference and is not a supported import API.",
      positionsM:Array.from(diagnostics.positions),velocitiesMPerS:Array.from(diagnostics.velocities),
      maximumOpeningM:Array.from(solver.maximumOpeningM),damage:Array.from(solver.damage),contactSides:Array.from(diagnostics.contactSides),
      cells:memory(diagnostics.cells),continuumCells:memory(diagnostics.continuum.cells),
      acceptedPose:solver.scalpelPose(),targetPose:{...diagnostics.targetPose},trialPose:{...diagnostics.trialPose},metrics:solver.metrics() });
    if (status !== "RUNNING") write("report", result);
  };
  const advance = (dt: number) => {
    if ((performance.now() - started) / 1000 >= config.maxWallSeconds) { status = "WALL_LIMIT"; return false; }
    if (requestedSteps >= config.maxSteps) { status = "STEP_LIMIT"; return false; }
    requestedSteps++;
    const stepStarted=performance.now(),accepted = solver.step(dt); maximumStepWallMs=Math.max(maximumStepWallMs,performance.now()-stepStarted); observe();
    if (!accepted) { status = "GATE_REJECTED"; error = solver.metrics().lastError; return false; }
    if (requestedSteps % 100 === 0 || performance.now()-lastPersistWall>=10000) { persist(); console.log(JSON.stringify({ phase: currentPhase, requestedSteps, metrics: solver.metrics() })); }
    return status === "RUNNING";
  };
  try {
    observe(true);
    for (const phase of phases) {
      currentPhase = phase.name;
      const phaseStart = performance.now(), timeStart = solver.metrics().timeSeconds, stepStart = requestedSteps;
      events.push({ phase: phase.name, event: "begin", timeSeconds: timeStart });
      if (phase.durationSeconds !== undefined) {
        while (solver.metrics().timeSeconds - timeStart < phase.durationSeconds - 1e-10)
          if (!advance(Math.min(solver.dtSeconds, phase.durationSeconds - (solver.metrics().timeSeconds - timeStart)))) break;
      } else {
        const target = phase.target!;
        while (status === "RUNNING") {
          const pose = solver.scalpelPose(), dy = target.tipYMm - pose.tipYMm, dz = target.centerZMm - pose.centerZMm;
          const distance = Math.hypot(dy, dz);
          if (distance < config.arrivalToleranceMm && pose.active === target.active) break;
          const fraction = Math.min(1, config.speedMmS * solver.dtSeconds / Math.max(distance, 1e-12));
          solver.setScalpelTarget({ active: target.active, tipYMm: pose.tipYMm + dy * fraction, centerZMm: pose.centerZMm + dz * fraction });
          if (!advance(solver.dtSeconds)) break;
        }
      }
      const report = { name: phase.name, completed: status === "RUNNING", requests: requestedSteps - stepStart,
        elapsedWallMs: performance.now() - phaseStart, pose: solver.scalpelPose(), metrics: solver.metrics() };
      phaseReports.push(report); events.push({ phase: phase.name, event: "end", completed: report.completed, timeSeconds: solver.metrics().timeSeconds });
      observe(true); persist(); console.log(JSON.stringify(report));
      if (status !== "RUNNING") break;
    }
    if (status === "RUNNING") status = "COMPLETED_CONFIGURED_GATES";
  } catch (cause) {
    status = "ERROR"; error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    try { observe(true); }
    catch (cause) { status = "ERROR"; error = cause instanceof Error ? cause.message : String(cause); }
    persist();
    console.log(JSON.stringify({ status, output: config.output, error }));
    if (status !== "COMPLETED_CONFIGURED_GATES") process.exitCode = 1;
  }
}

try { const config = parse(process.argv.slice(2)); if (config) run(config); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
