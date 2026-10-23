import { describe, expect, it } from "vitest";
import { CardiovascularCircuit, CV_COMPARTMENTS, type CardiovascularSnapshot } from "./cardiovascular";

function cycle(circuit: CardiovascularCircuit, seconds = 5) {
  const n = Math.round(seconds / circuit.config.fixedDtSeconds);
  let lo = Infinity, hi = -Infinity, output = 0, meanPressure = 0;
  for (let i = 0; i < n; i++) {
    const s = circuit.step(), p = s.pressuresPa.systemicArtery / 133.322;
    lo = Math.min(lo, p); hi = Math.max(hi, p);
    meanPressure += p / n; output += s.valveFlowsM3S.aortic * circuit.config.fixedDtSeconds;
    expect(Math.abs(s.volumeErrorM3)).toBeLessThan(2e-12);
    expect(Object.values(s.valveFlowsM3S).every(q => q >= 0)).toBe(true);
  }
  return { lo, hi, cardiacOutputLMin: output * 60e3 / seconds, meanPressure };
}
const pressureDistance = (a: CardiovascularSnapshot, b: CardiovascularSnapshot) =>
  Math.hypot(...CV_COMPARTMENTS.map(k => (a.pressuresPa[k] - b.pressuresPa[k]) / 133.322));

describe("conservative six-compartment cardiovascular circuit", () => {
  it("produces a finite periodic adult-scale circulation while preserving total blood volume", () => {
    const circuit = new CardiovascularCircuit(), stats = cycle(circuit);
    console.info("CV nominal numerical reference", stats);
    expect(stats.lo).toBeGreaterThan(50); expect(stats.hi).toBeLessThan(180);
    expect(stats.hi - stats.lo).toBeGreaterThan(15);
    expect(stats.cardiacOutputLMin).toBeGreaterThan(3); expect(stats.cardiacOutputLMin).toBeLessThan(9);
  });
  it("satisfies independent compartment balance using accepted terminal flows", () => {
    const c = new CardiovascularCircuit({ warmupCycles: 0 }), old = c.snapshot(), next = c.step();
    const q = [next.valveFlowsM3S.aortic, next.systemicFlowM3S, next.valveFlowsM3S.tricuspid,
      next.valveFlowsM3S.pulmonary, next.pulmonaryFlowM3S, next.valveFlowsM3S.mitral];
    for (let i = 0; i < 6; i++) {
      const key = CV_COMPARTMENTS[i]!;
      expect(Math.abs(next.compartmentVolumesM3[key] - old.compartmentVolumesM3[key] -
        c.config.fixedDtSeconds * (q[(i + 5) % 6]! - q[i]!))).toBeLessThan(2e-17);
    }
  });
  it("counts exact local withdrawal and distal return once, with transactional previews", () => {
    const c = new CardiovascularCircuit({ warmupCycles: 0 }), old = c.snapshot();
    const preview = c.prepareStep({ toLocalM3: 1e-7, fromLocalM3: 3e-8, source: "systemicArtery", returnTo: "systemicVein" });
    expect(c.snapshot()).toEqual(old); preview.snapshot.compartmentVolumesM3.lv = -1;
    preview.commit();
    expect(c.snapshot().circulatingVolumeM3).toBeCloseTo(old.circulatingVolumeM3 - 7e-8, 14);
    expect(c.snapshot().netTransferredToLocalM3).toBeCloseTo(7e-8, 20);
    expect(() => preview.commit()).toThrow();
    const checkpoint = c.checkpoint(), saved = c.snapshot(), stale = c.prepareStep();
    c.step(4); c.restore(checkpoint); expect(c.snapshot()).toEqual(saved);
    expect(() => stale.commit()).toThrow();
    expect(() => c.restore(new CardiovascularCircuit({ warmupCycles: 0 }).checkpoint())).toThrow();
  });
  it("rejects malformed/excessive transfers and invalid parameters without changing state", () => {
    const c = new CardiovascularCircuit({ warmupCycles: 0 }), before = c.snapshot();
    for (const toLocalM3 of [-Infinity, NaN, Infinity, 1])
      expect(() => c.prepareStep({ toLocalM3, fromLocalM3: 0, source: "systemicArtery", returnTo: "systemicVein" })).toThrow();
    expect(c.snapshot()).toEqual(before);
    expect(() => new CardiovascularCircuit({ heartRateBpm: NaN })).toThrow();
    expect(() => new CardiovascularCircuit({ fixedDtSeconds: 1 })).toThrow();
    expect(() => c.step(.5)).toThrow();
  });
  it("conserves independently checked signed transfers through both local ports", () => {
    for (const source of ["systemicArtery", "systemicVein"] as const)
      for (const returnTo of ["systemicVein", "rv"] as const)
        for (const signIn of [-1, 1]) for (const signOut of [-1, 1]) {
          const c = new CardiovascularCircuit({ warmupCycles: 0 }), old = c.snapshot();
          const exchange = { toLocalM3: signIn * 1e-8, fromLocalM3: signOut * 3e-8, source, returnTo };
          const preview = c.prepareStep(exchange); preview.commit(); const next = c.snapshot();
          const q = [next.valveFlowsM3S.aortic, next.systemicFlowM3S, next.valveFlowsM3S.tricuspid,
            next.valveFlowsM3S.pulmonary, next.pulmonaryFlowM3S, next.valveFlowsM3S.mitral];
          for (let i = 0; i < CV_COMPARTMENTS.length; i++) {
            const key = CV_COMPARTMENTS[i]!, transfer = (key === source ? -exchange.toLocalM3 : 0) +
              (key === returnTo ? exchange.fromLocalM3 : 0);
            expect(Math.abs(next.compartmentVolumesM3[key] - old.compartmentVolumesM3[key] - transfer -
              c.config.fixedDtSeconds * (q[(i + 5) % 6]! - q[i]!))).toBeLessThan(2e-17);
          }
          const inverse = c.prepareStep({ ...exchange, toLocalM3: -exchange.toLocalM3, fromLocalM3: -exchange.fromLocalM3 });
          inverse.commit();
          expect(c.snapshot().netTransferredToLocalM3).toBeCloseTo(0, 20);
          expect(c.snapshot().circulatingVolumeM3).toBeCloseTo(old.circulatingVolumeM3, 14);
        }
  });
  it("rejects reverse-donor exhaustion and aggregate double withdrawal without mutation", () => {
    const c = new CardiovascularCircuit({ warmupCycles: 0 }), before = c.snapshot();
    expect(() => c.prepareStep({ source: "systemicVein", returnTo: "rv", toLocalM3: 0,
      fromLocalM3: -before.availableSourceVolumeM3.rv - 1e-8 })).toThrow();
    const both = before.availableSourceVolumeM3.systemicVein * .7;
    expect(() => c.prepareStep({ source: "systemicVein", returnTo: "systemicVein",
      toLocalM3: both, fromLocalM3: -both })).toThrow();
    expect(c.snapshot()).toEqual(before);
  });
  it("equilibrates every displayed parameter boundary without negative systemic donor inventory", () => {
    // The initial local segment is accounted separately by the coordinator.
    // These are numerical UI-boundary checks, not physiological reference ranges.
    const localInitialVolumeM3 = 1.733e-6;
    let count = 0, minSystemicArteryPa = Infinity, minSystemicVeinPa = Infinity, minRvPa = Infinity;
    for (const heartRateBpm of [45, 140]) for (const systemicResistanceScale of [.75, 1, 1.25])
      for (const contractilityScale of [.75, 1, 1.25]) for (const totalVolume of [.0045, .005, .0055]) {
        const c = new CardiovascularCircuit({ heartRateBpm, systemicResistanceScale, contractilityScale,
          initialBloodVolumeM3: totalVolume - localInitialVolumeM3 });
        const n = Math.ceil(60 / heartRateBpm / c.config.fixedDtSeconds);
        for (let i = 0; i <= n; i++) {
          const s = i ? c.step() : c.snapshot();
          expect(Object.values(s.pressuresPa).every(Number.isFinite)).toBe(true);
          expect(Object.values(s.availableSourceVolumeM3).every(v => Number.isFinite(v) && v >= 0)).toBe(true);
          expect(Math.abs(s.volumeErrorM3)).toBeLessThan(2e-12);
          minSystemicArteryPa = Math.min(minSystemicArteryPa, s.pressuresPa.systemicArtery);
          minSystemicVeinPa = Math.min(minSystemicVeinPa, s.pressuresPa.systemicVein);
          minRvPa = Math.min(minRvPa, s.pressuresPa.rv);
        }
        count++;
      }
    expect(count).toBe(54);
    expect(minSystemicArteryPa).toBeGreaterThan(0); expect(minSystemicVeinPa).toBeGreaterThan(0);
    console.info("CV UI boundary envelope", { count, minSystemicArteryPa, minSystemicVeinPa, minRvPa });
  }, 20000);
  it("reduces pressure error when halving the accepted timestep", () => {
    const coarse = new CardiovascularCircuit({ fixedDtSeconds: .004 }), middle = new CardiovascularCircuit({ fixedDtSeconds: .002 });
    const fine = new CardiovascularCircuit({ fixedDtSeconds: .001 });
    coarse.step(250); middle.step(500); fine.step(1000);
    const a = pressureDistance(coarse.snapshot(), fine.snapshot()), b = pressureDistance(middle.snapshot(), fine.snapshot());
    expect(b).toBeLessThan(a * .7); expect(a).toBeLessThan(8);
  });
  it("dissipates passive circuit energy when ventricular activation is disabled", () => {
    const c = new CardiovascularCircuit({ warmupCycles: 0, contractilityScale: 0 });
    const v0 = [15, 715, 2500, 15, 90, 490].map(v => v * 1e-6);
    const compliance = [.0075, .0012, .075, .015, .00323, .0063].map(v => v * 1e-5);
    const external = [-4, -4 / 3, 0, -4, -4, -4].map(v => v * 133.322);
    const energy = (s: CardiovascularSnapshot) => CV_COMPARTMENTS.reduce((total, key, i) => {
      const v = s.compartmentVolumesM3[key];
      return total + (v - v0[i]!) ** 2 / (2 * compliance[i]!) + external[i]! * v;
    }, 0);
    let previous = energy(c.snapshot());
    for (let i = 0; i < 500; i++) {
      const next = energy(c.step()); expect(next).toBeLessThanOrEqual(previous + 1e-12); previous = next;
    }
  });
  it("blood loss changes the closed-loop pressure and output rather than preserving a prescribed pulse", () => {
    const baseline = new CardiovascularCircuit(), bleed = new CardiovascularCircuit(), dt = bleed.config.fixedDtSeconds;
    // Controlled 500 mL venous removal over ten seconds; a numerical
    // intervention test, not a proposed clinical protocol or calibrated shock.
    for (let i = 0; i < 10 / dt; i++) {
      const step = bleed.prepareStep({ toLocalM3: .0005 / 10 * dt, fromLocalM3: 0,
        source: "systemicVein", returnTo: "systemicVein" }); step.commit();
    }
    baseline.step(Math.round(10 / dt));
    const baseStats = cycle(baseline), bleedStats = cycle(bleed);
    console.info("CV loss response", { baseline: baseStats, bleed: bleedStats });
    expect(bleedStats.meanPressure).toBeLessThan(baseStats.meanPressure * .9);
    expect(bleedStats.cardiacOutputLMin).toBeLessThan(baseStats.cardiacOutputLMin * .9);
    expect(bleed.snapshot().circulatingVolumeM3).toBeCloseTo(.0045, 12);
    expect(bleed.snapshot().netTransferredToLocalM3).toBeCloseTo(.0005, 12);
  });
});
