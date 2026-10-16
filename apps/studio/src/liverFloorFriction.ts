/** Coulomb floor friction in SI units. The coefficient is a prescribed room
 * assumption, not a calibrated tissue property. No adhesion is modeled. */
export interface FloorFrictionResult {
  vxMps: number;
  vzMps: number;
  impulseXNs: number;
  impulseZNs: number;
  normalImpulseNs: number;
  frictionLimitNs: number;
  dissipatedEnergyJ: number;
}

/** Estimate the unilateral reaction from the final incremental-potential
 * gradient, in N. For y >= floor, stationarity gives reaction = dPhi/dy.
 * Phi must include inertia and every current material/tool term. At a finite
 * iteration budget this is a KKT reaction estimate, not a convergence proof.
 * Evaluate after the final complete sweep; an earlier vertex gradient is stale.
 */
export function estimateFloorNormalReaction(
  gapM: number,
  incrementalGradientYN: number,
  toleranceM = 1e-9,
): number {
  if (![gapM, incrementalGradientYN, toleranceM].every(Number.isFinite) || toleranceM < 0) {
    throw new Error("Invalid floor reaction input");
  }
  if (gapM < -toleranceM) throw new Error("Floor reaction requires a feasible position");
  return gapM <= toleranceM ? Math.max(0, incrementalGradientYN) : 0;
}

/** Maximum-dissipation tangential impulse for a stationary planar floor.
 * Projection cannot reverse slip or increase tangential kinetic energy.
 * Normal reaction is a force (N), not an impulse or downward velocity.
 * This split velocity update does not claim an implicit static-stick solve.
 */
export function applyFloorFriction(
  vxMps: number,
  vzMps: number,
  normalReactionN: number,
  massKg: number,
  dtS: number,
  coefficient: number,
): FloorFrictionResult {
  if (![vxMps, vzMps, normalReactionN, massKg, dtS, coefficient].every(Number.isFinite)
    || normalReactionN < 0 || massKg <= 0 || dtS <= 0 || coefficient < 0) {
    throw new Error("Invalid floor friction input");
  }
  const speed = Math.hypot(vxMps, vzMps);
  const normalImpulseNs = normalReactionN * dtS;
  const frictionLimitNs = coefficient * normalImpulseNs;
  const stoppingImpulseNs = massKg * speed;
  if (![speed, normalImpulseNs, frictionLimitNs, stoppingImpulseNs].every(Number.isFinite)) {
    throw new Error("Floor friction input overflows SI calculation");
  }
  const impulse = Math.min(stoppingImpulseNs, frictionLimitNs);
  const scale = stoppingImpulseNs > 0 ? Math.max(0, 1 - impulse / stoppingImpulseNs) : 1;
  const unitX = speed > 0 ? vxMps / speed : 0;
  const unitZ = speed > 0 ? vzMps / speed : 0;
  const dissipatedEnergyJ = impulse * (speed - .5 * impulse / massKg);
  if (!Number.isFinite(dissipatedEnergyJ)) throw new Error("Floor friction energy overflow");
  return {
    vxMps: vxMps * scale, vzMps: vzMps * scale,
    impulseXNs: -impulse * unitX, impulseZNs: -impulse * unitZ,
    normalImpulseNs, frictionLimitNs, dissipatedEnergyJ,
  };
}
