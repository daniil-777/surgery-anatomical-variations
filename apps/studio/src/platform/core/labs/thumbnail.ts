// Generic lab thumbnails: a cover-cropped still of the largest visible canvas, for labs whose adapter has no
// thumbnail() of its own. Lab canvases may be transparent WebGL (the organ viewport clears to alpha 0 over a CSS
// gradient), so the still is composited over an opaque background. Reading a WebGL canvas outside its render task only
// works with preserveDrawingBuffer (true in the organ and physics viewports); otherwise the read is blank, which is
// detected and reported as null rather than stored as an empty picture.

/** CSS colour, or radial-gradient stops from the centre outwards. */
export type ThumbnailBackground = string | readonly string[];

/** The organ stage's own backdrop (atlas.css .atlas-stage), so stills match what the lab shows. */
export const STAGE_BACKGROUND: readonly string[] = ["#2b3035", "#181e26", "#111720"];

export const RECORDING_ACTIVE_SELECTOR = 'canvas[data-scene-recording-active="true"]';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The centred source rectangle that covers a target of the given aspect (CSS object-fit: cover). */
export function coverCrop(sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): CropRect {
  if (!(sourceWidth > 0 && sourceHeight > 0 && targetWidth > 0 && targetHeight > 0)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = Math.min(sourceWidth, targetWidth / scale);
  const height = Math.min(sourceHeight, targetHeight / scale);
  return { x: (sourceWidth - width) / 2, y: (sourceHeight - height) / 2, width, height };
}

/** True when every pixel equals the first one (nothing drawn, or a cleared WebGL buffer). */
export function isUniform(pixels: Uint8ClampedArray): boolean {
  if (pixels.length < 8) return true;
  if (pixels.byteOffset % 4 === 0 && pixels.length % 4 === 0) {
    const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length / 4);
    const first = words[0];
    for (let i = 1; i < words.length; i++) if (words[i] !== first) return false;
    return true;
  }
  for (let i = 4; i < pixels.length; i++) if (pixels[i] !== pixels[i % 4]) return false;
  return true;
}

interface QueryRoot {
  querySelector(selectors: string): unknown;
}

/** A scene recording holds the GPU (and resizes its canvas); thumbnails and saves wait for it. */
export function isRecordingActive(root: QueryRoot | null | undefined): boolean {
  if (!root) return false;
  try {
    return root.querySelector(RECORDING_ACTIVE_SELECTOR) !== null;
  } catch {
    return false;
  }
}

/** The canvas covering the most visible viewport area, skipping empty, hidden and off-screen ones. */
export function largestVisibleCanvas(document: Document): HTMLCanvasElement | null {
  const view = document.defaultView;
  const viewWidth = view?.innerWidth ?? Number.POSITIVE_INFINITY;
  const viewHeight = view?.innerHeight ?? Number.POSITIVE_INFINITY;
  let best: HTMLCanvasElement | null = null;
  let bestArea = 0;
  for (const canvas of Array.from(document.querySelectorAll("canvas"))) {
    if (!(canvas.width > 0 && canvas.height > 0)) continue;
    const rect = canvas.getBoundingClientRect();
    const visibleWidth = Math.min(rect.right, viewWidth) - Math.max(rect.left, 0);
    const visibleHeight = Math.min(rect.bottom, viewHeight) - Math.max(rect.top, 0);
    if (!(visibleWidth > 0 && visibleHeight > 0)) continue;
    const style = view?.getComputedStyle?.(canvas);
    if (style && (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0)) continue;
    const area = visibleWidth * visibleHeight;
    if (area > bestArea) {
      best = canvas;
      bestArea = area;
    }
  }
  return best;
}

export interface ThumbnailOptions {
  width: number;
  height: number;
  background?: ThumbnailBackground | undefined;
  /** WebP quality (0–1). */
  quality?: number | undefined;
  /** The canvas to read (defaults to the largest visible canvas of the document). */
  source?: HTMLCanvasElement | null | undefined;
  /**
   * Creates the output canvas. Defaults to the platform's own document so the Blob belongs to the platform realm
   * (a Blob from a lab iframe can outlive its document badly); falls back to the lab document.
   */
  createCanvas?: ((width: number, height: number) => HTMLCanvasElement | null) | undefined;
}

function defaultCanvasFactory(fallback: Document): (width: number, height: number) => HTMLCanvasElement | null {
  return (width, height) => {
    const owner = (globalThis as { document?: Document }).document ?? fallback;
    const canvas = owner.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
}

function paintBackground(context: CanvasRenderingContext2D, width: number, height: number, background: ThumbnailBackground): void {
  if (typeof background === "string") {
    context.fillStyle = background;
  } else if (background.length === 1) {
    context.fillStyle = background[0] ?? "#000";
  } else {
    const radius = Math.hypot(width, height) / 2;
    const gradient = context.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, radius);
    background.forEach((stop, index) => gradient.addColorStop(index / Math.max(1, background.length - 1), stop));
    context.fillStyle = gradient;
  }
  context.fillRect(0, 0, width, height);
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

/** WebP where the browser encodes it (Safari answers PNG for an unsupported type), else PNG. */
export async function encodeThumbnail(canvas: HTMLCanvasElement, quality = 0.86): Promise<Blob | null> {
  const webp = await toBlob(canvas, "image/webp", quality);
  if (webp && webp.size > 0 && (webp.type === "image/webp" || webp.type === "image/png")) return webp;
  const png = await toBlob(canvas, "image/png");
  return png && png.size > 0 ? png : null;
}

/**
 * A width×height still of the lab's largest visible canvas over an opaque background, or null when a recording is
 * active, nothing is visible, the canvas cannot be read, or the read came back blank.
 */
export async function genericThumbnail(document: Document, options: ThumbnailOptions): Promise<Blob | null> {
  const width = Math.round(options.width);
  const height = Math.round(options.height);
  if (!(width > 0 && height > 0)) return null;
  if (isRecordingActive(document)) return null;
  const source = options.source === undefined ? largestVisibleCanvas(document) : options.source;
  if (!source || !(source.width > 0 && source.height > 0)) return null;
  const output = (options.createCanvas ?? defaultCanvasFactory(document))(width, height);
  const context = output?.getContext("2d") ?? null;
  if (!output || !context) return null;
  try {
    const crop = coverCrop(source.width, source.height, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
    // blank test on the lab's pixels alone, before the backdrop (which is not uniform when it is a gradient)
    if (isUniform(context.getImageData(0, 0, width, height).data)) return null;
    context.globalCompositeOperation = "destination-over";
    paintBackground(context, width, height, options.background ?? STAGE_BACKGROUND);
    context.globalCompositeOperation = "source-over";
  } catch {
    // a tainted or lost canvas cannot be read
    return null;
  }
  return encodeThumbnail(output, options.quality ?? 0.86);
}
