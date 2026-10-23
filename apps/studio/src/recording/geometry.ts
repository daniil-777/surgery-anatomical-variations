/** Aspect-preserving full-source composition. Black margins are encoded, never stretched. */
export function containRect(sourceWidth: number, sourceHeight: number, width: number, height: number) {
  if (![sourceWidth, sourceHeight, width, height].every(n => Number.isFinite(n) && n > 0)) throw new Error("Recording source has no drawable dimensions.");
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale, drawHeight = sourceHeight * scale;
  return { x: (width - drawWidth) / 2, y: (height - drawHeight) / 2, width: drawWidth, height: drawHeight, upscaled: scale > 1 + 1e-9 };
}
