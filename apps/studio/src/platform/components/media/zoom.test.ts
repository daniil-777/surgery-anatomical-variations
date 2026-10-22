import { describe, expect, it } from "vitest";
import { clampOffset, clampScale, fitScale, formatZoom, MAX_SCALE, MIN_SCALE, stepScale, wheelZoomFactor, zoomAbout } from "./zoom";

const viewport = { width: 400, height: 300 };

describe("image zoom", () => {
  it("fits large images and enlarges small ones up to 4×", () => {
    expect(fitScale({ width: 4000, height: 3000 }, viewport)).toBeCloseTo(0.1);
    expect(fitScale({ width: 800, height: 300 }, viewport)).toBeCloseTo(0.5);
    expect(fitScale({ width: 200, height: 150 }, viewport)).toBe(2);
    expect(fitScale({ width: 10, height: 10 }, viewport)).toBe(4);
    expect(fitScale({ width: 0, height: 10 }, viewport)).toBe(1);
  });

  it("steps through Preview's zoom levels with the fit as a stop", () => {
    expect(stepScale(1, 1, 0.5)).toBe(1.25);
    expect(stepScale(1, -1, 0.5)).toBe(0.75);
    expect(stepScale(0.4, 1, 0.42)).toBe(0.42);
    expect(stepScale(0.42, -1, 0.42)).toBe(0.33);
    expect(stepScale(MAX_SCALE, 1, 1)).toBe(MAX_SCALE);
    expect(stepScale(MIN_SCALE, -1, 1)).toBe(MIN_SCALE);
    expect(clampScale(Number.NaN)).toBe(1);
  });

  it("centres images smaller than the viewport and keeps larger ones covering it", () => {
    const image = { width: 400, height: 300 };
    expect(clampOffset({ scale: 0.5, x: 80, y: -50 }, image, viewport)).toEqual({ scale: 0.5, x: 0, y: 0 });
    // at 2× the image is 800 × 600: it may move 200 px sideways and 150 px vertically
    expect(clampOffset({ scale: 2, x: 500, y: -500 }, image, viewport)).toEqual({ scale: 2, x: 200, y: -150 });
  });

  it("zooms about a point without moving that point", () => {
    const image = { width: 400, height: 300 };
    const start = { scale: 1, x: 0, y: 0 };
    // the top-left quarter point (100, 75) stays under the pointer
    const next = zoomAbout(start, 2, { x: 100, y: 75 }, image, viewport);
    expect(next.scale).toBe(2);
    const imagePointBefore = { x: (100 - 200 - start.x) / start.scale, y: (75 - 150 - start.y) / start.scale };
    const imagePointAfter = { x: (100 - 200 - next.x) / next.scale, y: (75 - 150 - next.y) / next.scale };
    expect(imagePointAfter.x).toBeCloseTo(imagePointBefore.x);
    expect(imagePointAfter.y).toBeCloseTo(imagePointBefore.y);
    // zooming about the centre keeps the image centred
    expect(zoomAbout(start, 3, { x: 200, y: 150 }, image, viewport)).toEqual({ scale: 3, x: 0, y: 0 });
  });

  it("turns wheel deltas into zoom factors and formats percentages", () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
    expect(wheelZoomFactor(-1, 1)).toBeCloseTo(wheelZoomFactor(-16));
    expect(wheelZoomFactor(-1e9)).toBeCloseTo(wheelZoomFactor(-200));
    expect(formatZoom(1)).toBe("100%");
    expect(formatZoom(0.333)).toBe("33%");
    expect(formatZoom(0.05)).toBe("5%");
    expect(formatZoom(12)).toBe("1,200%");
  });
});
