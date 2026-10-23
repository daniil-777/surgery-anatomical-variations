import { describe, expect, it } from "vitest";
import { ScissorsClock } from "./scissorsClock";

describe("scissors fixed mechanical clock", () => {
  it("supplies identical mechanical time and substeps at 30, 60 and 144 display Hz", () => {
    const runs = [30, 60, 144].map(hz => {
      const clock = new ScissorsClock(), steps: number[] = [];
      for (let frame = 0; frame < 2 * hz; frame++) clock.advance(1 / hz, dt => steps.push(dt));
      expect(clock.snapshot().simulationSeconds).toBe(2);
      expect(clock.snapshot().droppedWallSeconds).toBe(0);
      return steps;
    });
    expect(runs[0]).toEqual(runs[1]); expect(runs[1]).toEqual(runs[2]);
    expect(runs[0]).toHaveLength(240);
  });
  it("bounds foreground catch-up, records skipped time and resets cleanly", () => {
    const clock = new ScissorsClock(); let calls = 0;
    expect(clock.advance(3, () => { calls++; })).toBe(8);
    expect(calls).toBe(8); expect(clock.snapshot().droppedWallSeconds).toBeCloseTo(3 - 8 / 120, 12);
    clock.reset(); expect(clock.snapshot()).toEqual(new ScissorsClock().snapshot());
  });
  it("rejects invalid elapsed time without advancing mechanics", () => {
    const clock = new ScissorsClock(), before = clock.snapshot();
    for (const bad of [-1, NaN, Infinity]) expect(() => clock.advance(bad, () => { throw new Error("must not step"); })).toThrow("finite and nonnegative");
    expect(clock.snapshot()).toEqual(before);
    expect(clock.advance(0, () => { throw new Error("must not step"); })).toBe(0);
  });
});
