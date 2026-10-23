import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { AtlasGeneration } from "../../atlas";
import { adaptLiverAnatomy } from "./anatomy";
import { prepareLiverCut } from "./wounds";
import { LiverFlowExperiment, liverTransferId } from "./liverFlow";
import { LiverSurfaceCollision } from "./surfaceCollision";
import { LiverSurfaceFlow } from "./surfaceFlow";
import { LiverRunoffExperiment } from "./runoff";
import { DryCollectorFilm, type DryCollectorDeposit, type DryCollectorSnapshot } from "./dryCollector";
import type { LiverAnatomy, LiverFlowSnapshot, LiverSurfacePick, LiverVec3 } from "./types";

const reference = () => adaptLiverAnatomy(JSON.parse(gunzipSync(readFileSync(new URL(
  "../../../../../public-copy/static/api/atlas/specimens/hra-liver-female.json.gz", import.meta.url))).toString()) as AtlasGeneration);
function opened(anatomy: LiverAnatomy) {
  const model = new LiverFlowExperiment(anatomy);
  const cut = prepareLiverCut(anatomy, [], { pick: anatomy.targets[0]!.pick,
    radiusM: .00125, depthM: .001, timeSeconds: 0 });
  expect(cut.outcome).toBe("vessel-hit"); model.setWounds([cut.wound!]);
  return model;
}
function step(model: LiverFlowExperiment) {
  const result = model.step();
  expect(result.accepted, result.reason).toBe(true);
}
function conserved(s: LiverFlowSnapshot) {
  const inventory = s.cardiovascular.circulatingVolumeM3 + s.vessel.vesselVolumeM3
    + s.breakup.inFlightVolumeM3 + s.film.filmVolumeM3 + s.runoff.attachedVolumeM3
    + s.runoff.inFlightVolumeM3 + s.pendingReturnVolumeM3
    + s.collector.filmVolumeM3 + s.terminalEscapeVolumeM3;
  expect(Math.abs(inventory - s.initialInventoryM3)).toBeLessThan(1e-12);
  expect(Math.abs(s.runoff.volumeErrorM3)).toBeLessThan(1e-17);
  expect(Math.abs(s.collector.volumeErrorM3)).toBeLessThan(1e-17);
}
function upperReturnFixture(anatomy: LiverAnatomy, cut: LiverSurfacePick): LiverSurfacePick {
  let selected: LiverSurfacePick | undefined;
  const { positionsM: p, normals, indices } = anatomy.surface;
  for (let t = 0; t < indices.length / 3; t++) {
    const ids = [indices[3 * t]!, indices[3 * t + 1]!, indices[3 * t + 2]!];
    // A distant, genuinely upward-facing neighborhood isolates the return
    // transaction from immediate underside drainage at a shallow guide target.
    if (ids.some(i => normals[3 * i + 1]! < .7)) continue;
    const at = (i: number): LiverVec3 => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
    const a = at(ids[0]!), b = at(ids[1]!), c = at(ids[2]!);
    const u = b.map((v, k) => v - a[k]!), v = c.map((n, k) => n - a[k]!);
    const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const size = Math.hypot(...cross);
    if (size < 2e-6 || cross[1]! / size < .8) continue;
    const positionM = [0, 1, 2].map(k => (a[k]! + b[k]! + c[k]!) / 3) as LiverVec3;
    if (Math.hypot(...positionM.map((n, k) => n - cut.positionM[k]!)) < .02) continue;
    if (!selected || positionM[1] > selected.positionM[1])
      selected = { triangle: t, barycentric: [1 / 3, 1 / 3, 1 / 3], positionM,
        normal: cross.map(n => n / size) as LiverVec3 };
  }
  if (!selected) throw new Error("No intact upper-face protocol destination");
  return selected;
}
afterEach(() => vi.restoreAllMocks());

describe("wet liver runoff transaction boundaries", () => {
  it("undoes an actual new deposit after collector commit, including replay IDs, then matches an uninterrupted control", () => {
    const anatomy = reference(), subject = opened(anatomy), control = opened(anatomy);
    let wet = false;
    // Both instances receive the same real wound and evolve normally. This is
    // an actual wet-state fixture, not synthetic scalar ledger replacement.
    for (let i = 0; i < 6000; i++) {
      step(subject); step(control);
      if (i % 20 !== 19) continue;
      const s = subject.snapshot();
      if (s.runoff.inputVolumeM3 > 0 && s.collector.filmVolumeM3 > 0) { wet = true; break; }
    }
    expect(wet, "Default target must produce real runoff and a wet collector within12 physical seconds").toBe(true);
    expect(subject.snapshot()).toEqual(control.snapshot());
    const originalPrepare = DryCollectorFilm.prototype.prepareStep;
    let before: LiverFlowSnapshot | undefined, expected: LiverFlowSnapshot | undefined;
    let observedDeposits: readonly DryCollectorDeposit[] = [];
    // Select a subsequent step that truly adds new blood. Merely committing an
    // already-wet but otherwise unchanged field would miss event-ID rollback.
    for (let i = 0; i < 2000; i++) {
      observedDeposits = [];
      const observer = vi.spyOn(DryCollectorFilm.prototype, "prepareStep")
        .mockImplementationOnce(function(this: DryCollectorFilm, events = []) {
          observedDeposits = events.map(e => ({ ...e, positionM: [...e.positionM], velocityMS: [...e.velocityMS] }));
          return originalPrepare.call(this, events);
        });
      try { step(control); } finally { observer.mockRestore(); }
      if (observedDeposits.length) { before = subject.snapshot(); expected = control.snapshot(); break; }
      step(subject);
    }
    expect(before, "A wet subsequent step must receive an actual new landing").toBeTruthy();
    expect(expected).toBeTruthy();
    expect(before!.collector.filmVolumeM3).toBeGreaterThan(0);
    expect(observedDeposits.reduce((v, e) => v + e.volumeM3, 0)).toBeGreaterThan(0);
    let committed: DryCollectorSnapshot | undefined, called = false;
    const fault = vi.spyOn(DryCollectorFilm.prototype, "prepareStep")
      .mockImplementationOnce(function(this: DryCollectorFilm, events = []) {
        expect(events).toEqual(observedDeposits);
        const prepared = originalPrepare.call(this, events), owner = this;
        expect(prepared.accepted, prepared.reason).toBe(true);
        return { ...prepared, commit() {
          prepared.commit(); called = true; committed = owner.snapshot();
          throw new Error("wet collector postcommit fixture");
        } };
      });
    try {
      expect(subject.step()).toEqual({ accepted: false, reason: "wet collector postcommit fixture" });
    } finally { fault.mockRestore(); }
    expect(called).toBe(true);
    expect(committed).toEqual(expected!.collector);
    expect(committed!.inputVolumeM3).toBeGreaterThan(before!.collector.inputVolumeM3);
    expect(subject.snapshot()).toEqual(before);
    conserved(subject.snapshot());
    // Successful retry proves restored deduplication, owner clocks and all
    // partially committed arrays, not only visually similar total volumes.
    step(subject);
    expect(subject.snapshot()).toEqual(expected);
    conserved(subject.snapshot());
    step(subject); step(control);
    expect(subject.snapshot()).toEqual(control.snapshot());
    console.info("Wet runoff rollback", JSON.stringify({ timeSeconds: before!.timeSeconds,
      collectorVolumeM3: before!.collector.filmVolumeM3, actualDeposits: observedDeposits.length,
      retryInputM3: subject.snapshot().collector.inputVolumeM3 }));
  }, 180_000);

  it("holds a forced runoff organ contact in a separate phase, then deposits it exactly once at the next boundary", () => {
    const anatomy = reference(), model = opened(anatomy), cut = anatomy.targets[0]!.pick;
    const destination = upperReturnFixture(anatomy, cut);
    const originalContact = LiverSurfaceCollision.prototype.contact;
    const originalRunoffStep = LiverRunoffExperiment.prototype.step;
    const originalFilmStep = LiverSurfaceFlow.prototype.step;
    let inRunoff = false, forced = 0;
    let detectedTime: number | undefined;
    const delivered: { id: number; timeSeconds: number; volumeM3: number; receiverStart: number }[] = [];
    // This intentionally replaces one collision result to test the protocol.
    // It is not evidence that this distant point is on the ballistic path.
    vi.spyOn(LiverRunoffExperiment.prototype, "step").mockImplementation(function(this: LiverRunoffExperiment, input) {
      inRunoff = true;
      try { return originalRunoffStep.call(this, input); } finally { inRunoff = false; }
    });
    vi.spyOn(LiverSurfaceCollision.prototype, "contact").mockImplementation(function(this: LiverSurfaceCollision, ...args) {
      const [, , , birth, start, end, supportRadius] = args;
      // Zero-radius probes belong to the wound source or attached bridge.
      // A nonzero interval with positive radius is detached runoff flight.
      if (inRunoff && forced === 0 && supportRadius > 0 && end > Math.max(start, birth)) {
        forced++; detectedTime = Math.max(start, birth);
        return { timeSeconds: detectedTime, positionM: [...destination.positionM],
          surface: { triangle: destination.triangle, barycentric: [...destination.barycentric] } };
      }
      return originalContact.apply(this, args);
    });
    vi.spyOn(LiverSurfaceFlow.prototype, "step").mockImplementation(function(this: LiverSurfaceFlow, events = [], footprints) {
      for (const event of events) if (event.holeId === "runoff")
        delivered.push({ id: event.id, timeSeconds: event.timeSeconds, volumeM3: event.volumeM3,
          receiverStart: this.snapshot().timeSeconds });
      return originalFilmStep.call(this, events, footprints);
    });
    let pending: LiverFlowSnapshot | undefined;
    for (let i = 0; i < 6000; i++) {
      step(model);
      if (forced) { pending = model.snapshot(); break; }
    }
    expect(forced, "The real default drainage must create detached runoff flight for this fixture").toBe(1);
    expect(pending).toBeTruthy();
    const contact = pending!.runoff.contacts.find(e => e.surface?.triangle === destination.triangle
      && e.timeSeconds === detectedTime);
    expect(contact).toBeTruthy();
    const eventId = liverTransferId(contact!.id, "runoff");
    const waiting = pending!.pendingReturnEvents.find(e => e.id === eventId);
    expect(waiting).toBeTruthy();
    expect(waiting!.detectedTimeSeconds).toBe(contact!.timeSeconds);
    expect(waiting!.timeSeconds).toBe(pending!.timeSeconds);
    expect(waiting!.detectedTimeSeconds).toBeLessThan(waiting!.timeSeconds);
    expect(waiting!.surface).toEqual(contact!.surface);
    expect(waiting!.volumeM3).toBe(contact!.volumeM3);
    expect(pending!.pendingReturnVolumeM3).toBeGreaterThanOrEqual(contact!.volumeM3);
    expect(delivered.filter(e => e.id === eventId)).toEqual([]);
    const inputBefore = pending!.film.inputVolumeM3;
    conserved(pending!);

    step(model);
    const deposited = model.snapshot();
    const matches = delivered.filter(e => e.id === eventId);
    expect(matches).toHaveLength(1);
    expect(matches[0]!).toEqual({ id: eventId, timeSeconds: waiting!.timeSeconds,
      volumeM3: waiting!.volumeM3, receiverStart: pending!.timeSeconds });
    expect(deposited.pendingReturnEvents.some(e => e.id === eventId)).toBe(false);
    const freshWoundVolume = deposited.breakup.landingEvents.filter(e => e.surface).reduce((v, e) => v + e.volumeM3, 0);
    expect(Math.abs(deposited.film.inputVolumeM3 - inputBefore - pending!.pendingReturnVolumeM3 - freshWoundVolume))
      .toBeLessThan(1e-17);
    conserved(deposited);
    for (let i = 0; i < 3; i++) step(model);
    expect(delivered.filter(e => e.id === eventId)).toHaveLength(1);
    conserved(model.snapshot());
    console.info("Forced runoff return protocol", JSON.stringify({ rawId: contact!.id, receiverId: eventId,
      detectedTimeSeconds: waiting!.detectedTimeSeconds, depositionTimeSeconds: waiting!.timeSeconds,
      massM3: waiting!.volumeM3, fixture: "synthetic collision response; no trajectory-realism claim" }));
  }, 180_000);
});
