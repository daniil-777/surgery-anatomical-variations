import type { BloodScene } from "./scene";

/** The physical tray occupies two layers of cells. A fluid sample represents a
 * cell of width dx, so its centre must stay half a cell inside the liquid domain.
 * This is a declared finite-resolution collision envelope, not a fitted bore. */
export function trayGeometry(scene: BloodScene) {
  const spacing = scene.lengthM / (2 * scene.axis);
  return { spacing, wall: 2 * spacing, sampleRadius: .5 * spacing,
    minimumCentre: 2.5 * spacing, maximumCentre: scene.lengthM - 2.5 * spacing };
}

/** Frictionless, inelastic unilateral contact over the next fixed step.
 * The impulse changes normal velocity only; pressure and viscous wall terms
 * must still be solved separately. Used as an independent CPU test reference. */
export function projectTrayVelocity(position: readonly number[], velocity: readonly number[], scene: BloodScene): number[] {
  const { minimumCentre: lo, maximumCentre: hi } = trayGeometry(scene);
  const dt = Math.fround(scene.dtSeconds);
  return velocity.map((v, axis) => {
    const lower = Math.min(0, (lo - position[axis]!) / dt);
    const upper = axis === 1 ? Infinity : Math.max(0, (hi - position[axis]!) / dt);
    return Math.min(upper, Math.max(lower, v));
  });
}
