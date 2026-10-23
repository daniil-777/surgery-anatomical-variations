/** Irreversible bilinear Mode-I coupon law. SI units; alpha is a fixed model
 * assumption, not a learned liver property. Compression stays undamaged. */
export interface CohesiveParameters { fractureEnergyJm2: number; peakTractionPa: number }
export const COHESIVE_ONSET_RATIO = .12;
export function cohesiveParameters(p: CohesiveParameters) {
  if (!Number.isFinite(p.fractureEnergyJm2) || !Number.isFinite(p.peakTractionPa) || p.fractureEnergyJm2 <= 0 || p.peakTractionPa <= 0) throw new Error("Positive finite fracture energy and peak traction required.");
  const deltafM = 2 * p.fractureEnergyJm2 / p.peakTractionPa;
  const delta0M = COHESIVE_ONSET_RATIO * deltafM;
  const stiffnessPaPerM = p.peakTractionPa / delta0M;
  if (!(deltafM > 0) || !(delta0M > 0) || !(stiffnessPaPerM > 0) || !Number.isFinite(deltafM) || !Number.isFinite(delta0M) || !Number.isFinite(stiffnessPaPerM)) throw new Error("Unrepresentable cohesive parameters.");
  return { delta0M, deltafM, stiffnessPaPerM };
}
export function cohesiveEffectiveOpening(gapX: number, gapY: number, gapZ: number, shearCouplingBeta = 1): number {
  if (!(shearCouplingBeta > 0) || !Number.isFinite(shearCouplingBeta)) throw new Error("Positive finite shear coupling beta required.");
  const nx = Math.max(0, gapX);
  return shearCouplingBeta === 1 ? Math.hypot(nx, gapY, gapZ) : Math.hypot(nx, shearCouplingBeta * gapY, shearCouplingBeta * gapZ);
}
export function cohesiveResponse(openingM: number, maximumOpeningM: number, p: CohesiveParameters) {
  if (!Number.isFinite(openingM) || !Number.isFinite(maximumOpeningM) || maximumOpeningM < 0) throw new Error("Finite opening and nonnegative history required.");
  const { delta0M: d0, deltafM: df, stiffnessPaPerM: K } = cohesiveParameters(p);
  const history = Math.max(maximumOpeningM, openingM, 0), k = Math.min(history, df);
  const damage = k <= d0 ? 0 : k >= df ? 1 : df * (k - d0) / (k * (df - d0));
  const secant = openingM < 0 ? K : (1 - damage) * K;
  const tractionPa = secant * openingM;
  const loadingSoftening = openingM > d0 && openingM < df && openingM >= maximumOpeningM;
  const tangentPaPerM = loadingSoftening ? -p.peakTractionPa / (df - d0) : secant;
  const envelopeWork = k <= d0 ? .5 * K * k * k : .5 * p.peakTractionPa * d0 + p.peakTractionPa * ((k - d0) - (k - d0) ** 2 / (2 * (df - d0)));
  const dissipatedEnergyJm2 = Math.max(0, envelopeWork - .5 * (1 - damage) * K * k * k);
  return { tractionPa, tangentPaPerM, damage, maximumOpeningM: history, storedEnergyJm2: .5 * secant * openingM * openingM, dissipatedEnergyJm2 };
}
