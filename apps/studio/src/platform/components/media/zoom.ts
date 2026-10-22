// Zoom and pan maths of the image viewer: the fitted scale, Preview-style zoom steps, zooming about a point (the pointer
// or the centre) and keeping the image on screen while panning. Pure, so it is unit-tested in node.

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** scale = rendered pixels per image pixel; (x, y) = offset of the image centre from the viewport centre. */
export interface ZoomState {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 16;
/** Small images are enlarged to fill the frame, but never past 4× (beyond that a fit looks like a mistake). */
export const MAX_FIT_SCALE = 4;
export const ZOOM_STEPS: readonly number[] = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];

function valid(size: Size): boolean {
  return size.width > 0 && size.height > 0 && Number.isFinite(size.width) && Number.isFinite(size.height);
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** The scale at which the whole image fits the viewport (letterboxed). */
export function fitScale(image: Size, viewport: Size): number {
  if (!valid(image) || !valid(viewport)) return 1;
  return clampScale(Math.min(viewport.width / image.width, viewport.height / image.height, MAX_FIT_SCALE));
}

/** The next step up (+1) or down (−1) from `scale`, with the fitted scale treated as one more step. */
export function stepScale(scale: number, direction: 1 | -1, fit: number): number {
  const steps = [...new Set([...ZOOM_STEPS, Number(fit.toFixed(4))])].sort((a, b) => a - b);
  const epsilon = 1e-4;
  if (direction > 0) return clampScale(steps.find((step) => step > scale + epsilon) ?? MAX_SCALE);
  return clampScale([...steps].reverse().find((step) => step < scale - epsilon) ?? MIN_SCALE);
}

/**
 * Keeps the image on screen: along an axis where it is smaller than the viewport it is centred; where it is larger,
 * its edges never come inside the viewport's edges.
 */
export function clampOffset(state: ZoomState, image: Size, viewport: Size): ZoomState {
  if (!valid(image) || !valid(viewport)) return { ...state, x: 0, y: 0 };
  const limitX = Math.max(0, (image.width * state.scale - viewport.width) / 2);
  const limitY = Math.max(0, (image.height * state.scale - viewport.height) / 2);
  // "+ 0" turns -0 into 0
  return {
    scale: state.scale,
    x: Math.min(limitX, Math.max(-limitX, state.x)) + 0,
    y: Math.min(limitY, Math.max(-limitY, state.y)) + 0,
  };
}

/**
 * Zooms to `scale` keeping the image point under `anchor` (viewport coordinates, origin top-left) where it is —
 * the pointer for wheel/pinch zoom, the viewport centre for buttons.
 */
export function zoomAbout(state: ZoomState, scale: number, anchor: Point, image: Size, viewport: Size): ZoomState {
  const next = clampScale(scale);
  const ratio = next / state.scale;
  // anchor relative to the viewport centre
  const ax = anchor.x - viewport.width / 2;
  const ay = anchor.y - viewport.height / 2;
  const x = ax - (ax - state.x) * ratio;
  const y = ay - (ay - state.y) * ratio;
  return clampOffset({ scale: next, x, y }, image, viewport);
}

/** Wheel delta (pixels) → zoom factor; pinch gestures arrive as ctrl+wheel with small deltas. */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(-Math.max(-200, Math.min(200, pixels)) * 0.0045);
}

/** "100 %" style label; percentages below 10 keep one decimal place. */
export function formatZoom(scale: number): string {
  const percent = scale * 100;
  const digits = percent < 10 ? 1 : 0;
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(percent)}%`;
}
