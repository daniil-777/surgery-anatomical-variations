import { CUTTING_NUMERICS } from "./numerics";
import type { CuttingMetrics } from "./solver";
import type { CuttingOptions, CuttingReference, ScalpelPose } from "./types";

interface Response { id: number; accepted: boolean; error?: string; positionsMm: Float64Array;
  damage: Float64Array; metrics: CuttingMetrics; pose: ScalpelPose; dtSeconds: number }
/** One in-flight mechanical step. Rendering uses the last accepted snapshot;
 * physical time is never inferred from display FPS or elapsed wall time. */
export class CuttingWorkerClient {
  ready: Promise<void>;
  positionsMm: Float64Array;
  damage: Float64Array;
  dtSeconds: number;
  readonly equilibriumModel: NonNullable<CuttingOptions["equilibriumModel"]>;
  private currentMetrics: CuttingMetrics;
  private pose: ScalpelPose;
  private worker!: Worker;
  private failure: Error | undefined;
  private sequence = 0;
  private disposed = false;
  private stepping = false;
  private readonly pending = new Map<number, { resolve: (value: Response) => void; reject: (error: Error) => void }>();
  constructor(private readonly reference: CuttingReference, private readonly options: CuttingOptions) {
    this.positionsMm = Float64Array.from(reference.positionsMm);
    this.damage = new Float64Array(reference.seamPairs.length);
    this.dtSeconds = options.dtSeconds ?? CUTTING_NUMERICS.defaultDtSeconds;
    this.equilibriumModel=options.equilibriumModel??CUTTING_NUMERICS.defaultEquilibriumModel;
    const y = reference.seamPairs.map(p => reference.positionsMm[3 * p.left + 1]!);
    const z = reference.seamPairs.map(p => reference.positionsMm[3 * p.left + 2]!);
    this.pose = { tipYMm: Math.max(...y) + 2, centerZMm: (Math.min(...z) + Math.max(...z)) / 2, active: false };
    this.currentMetrics = { timeSeconds: 0, acceptedSteps: 0, rejectedSteps: 0, lastStepSeconds: 0, lastStepSweeps: 0, lastGlobalIterations: 0, timeStepRetries: 0, minimumJacobian: 1,
      volumeRatio: 1, totalMassKg: reference.diagnostics.splitVolumeM3 * options.bulk.density_kg_m3,
      contactForceN: [0, 0, 0], toolWorkJ: 0, fractureDissipationJ: 0,
      damagedAreaM2: 0, separatedAreaM2: 0,
      seamAreaM2: reference.diagnostics.seamAreaM2, maximumOpeningMm: 0,
      cohesiveAreaM2: typeof reference.diagnostics.capAreaM2 === "number" ? reference.diagnostics.capAreaM2 : reference.diagnostics.seamAreaM2,
      maximumContactPenetrationMm: 0, maximumSurfacePenetrationMm: null, fixtureEnergyJ: 0, stationarityResidualN: 0, lastError: "" };
    this.ready = this.initialize();
  }
  private initialize(): Promise<void> {
    this.failure = undefined;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<Response>) => {
      if (this.worker !== worker) return;
      const response = event.data, pending = this.pending.get(response.id);
      if (!pending || this.disposed) return;
      this.pending.delete(response.id);
      if (response.error) { pending.reject(new Error(response.error)); return; }
      this.positionsMm = response.positionsMm; this.damage = response.damage;
      this.currentMetrics = response.metrics; this.pose = response.pose; this.dtSeconds = response.dtSeconds;
      pending.resolve(response);
    };
    const fail = () => {
      if (this.worker !== worker || this.disposed) return;
      this.failure = new Error("The cutting worker stopped. Reset the experiment to restore it.");
      worker.terminate();
      for (const pending of this.pending.values()) pending.reject(this.failure);
      this.pending.clear();
    };
    worker.onerror = fail; worker.onmessageerror = fail;
    return this.request({ action: "init", reference: this.reference, options: this.options }).then(() => undefined);
  }
  private request(message: Record<string, unknown>): Promise<Response> {
    if (this.disposed) return Promise.reject(new Error("Cutting worker disposed"));
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker.postMessage({ ...message, id }); }
      catch (error) { this.pending.delete(id); reject(error instanceof Error ? error : new Error("Could not send cutting operation")); }
    });
  }
  metrics(): CuttingMetrics { return { ...this.currentMetrics, contactForceN: [...this.currentMetrics.contactForceN] }; }
  scalpelPose(): ScalpelPose { return { ...this.pose }; }
  async step(pose: ScalpelPose): Promise<boolean> {
    if (this.stepping) throw new Error("A cutting step is already in flight");
    this.stepping = true;
    try { await this.ready; return (await this.request({ action: "step", pose })).accepted; }
    finally { this.stepping = false; }
  }
  async reset(): Promise<void> {
    if (this.disposed) throw new Error("Cutting worker disposed");
    if (this.failure) { this.ready = this.initialize(); await this.ready; }
    else { await this.ready; await this.request({ action: "reset" }); }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("Cutting worker disposed"));
    this.pending.clear();
  }
}
