import type { PhysicsPlayground } from "./atlasPhysics";
import type { PlaygroundInteractionState, PlaygroundMetrics } from "./liverPlaygroundSolver";

export interface LiverMotionSample {
  wall_time_s: number;
  segment: number;
  metrics: PlaygroundMetrics;
  node_positions_mm: number[];
  camera_position_mm: number[];
  camera_target_mm: number[];
  camera_fov_degrees: number;
  camera_aspect: number;
  tool: string;
  paused: boolean;
  gravity: boolean;
  contact: PlaygroundInteractionState;
}
type SampleInput = Omit<LiverMotionSample, "wall_time_s" | "segment">;
type StopReason = "user" | "sample_limit" | "scene_changed" | "invalid_state";

/** Bounded, opt-in measurement capture. Actual timestamps are retained; no resampling. */
export class LiverMotionCapture {
  readonly sampleLimit: number;
  readonly startedAtIso: string;
  private readonly prepared: PhysicsPlayground;
  private readonly startedMs: number;
  private lastSampleMs = -Infinity;
  private segment = 0;
  private stopReason: StopReason | null = null;
  private readonly samples: LiverMotionSample[] = [];
  private readonly events: { wall_time_s: number; segment: number; action: string; details?: Record<string, number | string | boolean | number[]> }[] = [];
  constructor(prepared: PhysicsPlayground, startedMs: number, startedAtIso = new Date().toISOString()) {
    const coordinates = prepared.mesh.reference_positions_mm.length;
    if (!coordinates || coordinates % 3 || !Number.isFinite(startedMs)) throw new Error("Invalid recording source");
    this.prepared = structuredClone(prepared);
    this.startedMs = startedMs; this.startedAtIso = startedAtIso;
    this.sampleLimit = Math.max(1, Math.min(900, Math.floor(600000 / coordinates)));
  }
  get active(): boolean { return this.stopReason === null; }
  get count(): number { return this.samples.length; }
  get reason(): StopReason | null { return this.stopReason; }
  get segments(): number { return this.segment + 1; }
  wantsSample(nowMs: number): boolean { return this.active && Number.isFinite(nowMs) && nowMs >= this.startedMs && nowMs - this.lastSampleMs >= 1000 / 30; }
  event(action: string, nowMs: number, startsSegment = false, details?: Record<string, number | string | boolean | number[]>): void {
    if (!this.active || !Number.isFinite(nowMs) || nowMs < this.startedMs) return;
    if (startsSegment) this.segment++;
    if (this.events.length < 3000) this.events.push(structuredClone({ wall_time_s: (nowMs - this.startedMs) / 1000, segment: this.segment, action, ...(details ? { details } : {}) }));
  }
  add(input: SampleInput, nowMs: number): boolean {
    if (!this.wantsSample(nowMs)) return false;
    if (input.node_positions_mm.length !== this.prepared.mesh.reference_positions_mm.length || !input.node_positions_mm.every(Number.isFinite) || !input.metrics.finite_state || !Number.isFinite(input.metrics.simulation_time_s)) { this.stop("invalid_state"); return false; }
    const previous = this.samples[this.samples.length - 1];
    if (previous?.segment === this.segment && input.metrics.simulation_time_s < previous.metrics.simulation_time_s) this.event("simulation_clock_reset", nowMs, true);
    this.samples.push(structuredClone({ ...input, wall_time_s: (nowMs - this.startedMs) / 1000, segment: this.segment }));
    this.lastSampleMs = nowMs;
    if (this.samples.length >= this.sampleLimit) this.stop("sample_limit");
    return true;
  }
  stop(reason: StopReason = "user"): void { this.stopReason ??= reason; }
  export() {
    return structuredClone({
      schema: "viscera.liver-motion-capture/1", recorded_at: this.startedAtIso,
      scope: "Synthetic simulator measurements, not acquired human tissue or force calibration.",
      sampling: { method: "render_callback_at_most_30_hz", fixed_rate: false, maximum_samples: this.sampleLimit, actual_samples: this.count, stop_reason: this.stopReason, expert_human_validation: "NOT_RUN" },
      units: { positions: "mm", time: "s", force: "N", work: "J" },
      conventions: { probe_reaction: "force on tool", probe_work: "signed work on tissue over accepted tool-center increments; not a complete energy balance", punch: "Instantaneous authored velocity impulse; event records actual momentum and kinetic-energy changes before subsequent integration. No peak force is inferred.", segments: "Reset and drop begin a new segment. Paused time is retained. No interpolation or time alignment applied." },
      source: this.prepared.source, parameters: this.prepared.parameters, learning: this.prepared.learning,
      cage: { reference_positions_mm: this.prepared.mesh.reference_positions_mm, tets: this.prepared.mesh.tets, surface_indices: this.prepared.mesh.surface_indices },
      room: this.prepared.room, simulation: this.prepared.simulation ?? null, events: this.events, samples: this.samples,
    });
  }
}
