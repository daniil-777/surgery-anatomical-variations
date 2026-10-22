import { describe, expect, it } from "vitest";
import { STAGE_BACKGROUND, coverCrop, genericThumbnail, isRecordingActive, isUniform, largestVisibleCanvas } from "./thumbnail";

describe("cover crop", () => {
  it("crops the sides of a wider source", () => {
    const crop = coverCrop(1920, 1080, 640, 400);
    expect(crop.width).toBeCloseTo(1728);
    expect(crop.height).toBeCloseTo(1080);
    expect(crop.x).toBeCloseTo(96);
    expect(crop.y).toBeCloseTo(0);
  });

  it("crops top and bottom of a taller source and keeps a matching aspect whole", () => {
    const crop = coverCrop(1000, 1000, 640, 400);
    expect(crop).toEqual({ x: 0, y: 187.5, width: 1000, height: 625 });
    expect(coverCrop(1280, 800, 640, 400)).toEqual({ x: 0, y: 0, width: 1280, height: 800 });
  });

  it("scales a small source up without leaving its bounds", () => {
    const crop = coverCrop(320, 100, 640, 400);
    expect(crop.height).toBeCloseTo(100);
    expect(crop.width).toBeCloseTo(160);
    expect(crop.x).toBeCloseTo(80);
    expect(coverCrop(0, 100, 640, 400)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe("blank detection", () => {
  it("is uniform only when every pixel matches", () => {
    const pixels = new Uint8ClampedArray(4 * 64).fill(0);
    expect(isUniform(pixels)).toBe(true);
    pixels[4 * 63 + 3] = 1;
    expect(isUniform(pixels)).toBe(false);
    expect(isUniform(new Uint8ClampedArray([9, 9, 9, 255]))).toBe(true);
    // an unaligned view takes the byte-wise path
    const unaligned = new Uint8ClampedArray(4 * 8 + 1).fill(7).subarray(1);
    expect(isUniform(unaligned)).toBe(true);
    unaligned[17] = 8;
    expect(isUniform(unaligned)).toBe(false);
  });

  it("notices an active scene recording", () => {
    expect(isRecordingActive({ querySelector: (selector) => (selector.includes('data-scene-recording-active="true"') ? {} : null) })).toBe(true);
    expect(isRecordingActive({ querySelector: () => null })).toBe(false);
    expect(isRecordingActive({ querySelector: () => { throw new Error("detached"); } })).toBe(false);
    expect(isRecordingActive(null)).toBe(false);
  });
});

interface FakeRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function fakeCanvas(width: number, height: number, rect: FakeRect, computed: Partial<Record<"visibility" | "display" | "opacity", string>> = {}) {
  return { width, height, computed, getBoundingClientRect: () => rect };
}

function fakeDocument(canvases: Array<ReturnType<typeof fakeCanvas>>, recording = false): Document {
  return {
    defaultView: {
      innerWidth: 1000,
      innerHeight: 800,
      getComputedStyle: (element: ReturnType<typeof fakeCanvas>) => ({ visibility: "visible", display: "block", opacity: "1", ...element.computed }),
    },
    querySelectorAll: () => canvases,
    querySelector: () => (recording ? {} : null),
  } as unknown as Document;
}

describe("canvas discovery", () => {
  it("picks the canvas with the largest visible area", () => {
    const small = fakeCanvas(600, 300, { left: 0, top: 0, right: 300, bottom: 150 });
    const partly = fakeCanvas(2000, 1600, { left: 500, top: 400, right: 1500, bottom: 1200 });
    const hidden = fakeCanvas(4000, 4000, { left: 0, top: 0, right: 1000, bottom: 800 }, { visibility: "hidden" });
    const transparent = fakeCanvas(4000, 4000, { left: 0, top: 0, right: 1000, bottom: 800 }, { opacity: "0" });
    const empty = fakeCanvas(0, 0, { left: 0, top: 0, right: 1000, bottom: 800 });
    const offscreen = fakeCanvas(800, 800, { left: 2000, top: 0, right: 2800, bottom: 800 });
    const document = fakeDocument([small, hidden, transparent, empty, offscreen, partly]);
    expect(largestVisibleCanvas(document)).toBe(partly);
    expect(largestVisibleCanvas(fakeDocument([empty, offscreen]))).toBeNull();
  });
});

interface Recorded {
  name: string;
  args: unknown[];
}

function fakeOutput(pixels: Uint8ClampedArray | "tainted", webp: "webp" | "png" | "none") {
  const calls: Recorded[] = [];
  const context = {
    fillStyle: "" as unknown,
    globalCompositeOperation: "source-over",
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    drawImage: (...args: unknown[]) => {
      calls.push({ name: "drawImage", args });
    },
    getImageData: () => {
      calls.push({ name: "getImageData", args: [] });
      if (pixels === "tainted") throw new Error("The canvas has been tainted by cross-origin data.");
      return { data: pixels };
    },
    fillRect: (...args: unknown[]) => {
      calls.push({ name: `fillRect ${context.globalCompositeOperation}`, args: [context.fillStyle, ...args] });
    },
    createRadialGradient: () => ({
      addColorStop: (offset: number, color: string) => {
        calls.push({ name: "stop", args: [offset, color] });
      },
    }),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: (kind: string) => (kind === "2d" ? context : null),
    toBlob: (callback: (blob: Blob | null) => void, type?: string) => {
      calls.push({ name: "toBlob", args: [type] });
      if (type === "image/webp") {
        callback(webp === "webp" ? new Blob(["webp"], { type: "image/webp" }) : webp === "png" ? new Blob(["png"], { type: "image/png" }) : null);
      } else {
        callback(new Blob(["png"], { type: "image/png" }));
      }
    },
  };
  return { calls, create: (width: number, height: number) => Object.assign(canvas, { width, height }) as unknown as HTMLCanvasElement };
}

function drawnPixels(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(4 * 16);
  pixels[5] = 200;
  return pixels;
}

describe("generic thumbnail", () => {
  const source = { width: 1920, height: 1080 } as unknown as HTMLCanvasElement;
  const document = fakeDocument([]);

  it("draws the cover crop, checks for blank pixels, puts the backdrop behind and encodes WebP", async () => {
    const output = fakeOutput(drawnPixels(), "webp");
    const blob = await genericThumbnail(document, { width: 640, height: 400, source, createCanvas: output.create });
    expect(blob?.type).toBe("image/webp");
    expect(output.calls.map((call) => call.name)).toEqual([
      "drawImage",
      "getImageData",
      "stop",
      "stop",
      "stop",
      "fillRect destination-over",
      "toBlob",
    ]);
    const [image, x, y, w, h, dx, dy, dw, dh] = output.calls[0]!.args as [unknown, number, number, number, number, number, number, number, number];
    expect(image).toBe(source);
    expect([x, y, w, h].map(Math.round)).toEqual([96, 0, 1728, 1080]);
    expect([dx, dy, dw, dh]).toEqual([0, 0, 640, 400]);
    expect(output.calls.filter((call) => call.name === "stop").map((call) => call.args[1])).toEqual([...STAGE_BACKGROUND]);
  });

  it("uses a solid backdrop when asked", async () => {
    const output = fakeOutput(drawnPixels(), "webp");
    await genericThumbnail(document, { width: 64, height: 40, source, background: "#101010", createCanvas: output.create });
    expect(output.calls.find((call) => call.name === "fillRect destination-over")?.args[0]).toBe("#101010");
  });

  it("returns null for a blank read and never encodes it", async () => {
    const output = fakeOutput(new Uint8ClampedArray(4 * 16), "webp");
    expect(await genericThumbnail(document, { width: 640, height: 400, source, createCanvas: output.create })).toBeNull();
    expect(output.calls.map((call) => call.name)).not.toContain("toBlob");
  });

  it("accepts Safari's PNG answer and falls back to PNG when WebP fails", async () => {
    const safari = fakeOutput(drawnPixels(), "png");
    expect((await genericThumbnail(document, { width: 64, height: 40, source, createCanvas: safari.create }))?.type).toBe("image/png");
    const none = fakeOutput(drawnPixels(), "none");
    expect((await genericThumbnail(document, { width: 64, height: 40, source, createCanvas: none.create }))?.type).toBe("image/png");
    expect(none.calls.filter((call) => call.name === "toBlob").map((call) => call.args[0])).toEqual(["image/webp", "image/png"]);
  });

  it("refuses during a recording, for tainted canvases and for empty sizes", async () => {
    const output = fakeOutput(drawnPixels(), "webp");
    expect(await genericThumbnail(fakeDocument([], true), { width: 640, height: 400, source, createCanvas: output.create })).toBeNull();
    expect(output.calls).toEqual([]);
    const tainted = fakeOutput("tainted", "webp");
    expect(await genericThumbnail(document, { width: 640, height: 400, source, createCanvas: tainted.create })).toBeNull();
    expect(await genericThumbnail(document, { width: 0, height: 400, source, createCanvas: output.create })).toBeNull();
    expect(await genericThumbnail(document, { width: 640, height: 400, source: null, createCanvas: output.create })).toBeNull();
  });

  it("finds the source canvas itself when none is given", async () => {
    const canvas = Object.assign(fakeCanvas(1280, 800, { left: 0, top: 0, right: 1000, bottom: 625 }), {});
    const output = fakeOutput(drawnPixels(), "webp");
    await genericThumbnail(fakeDocument([canvas]), { width: 640, height: 400, createCanvas: output.create });
    expect(output.calls[0]?.args[0]).toBe(canvas);
  });
});
