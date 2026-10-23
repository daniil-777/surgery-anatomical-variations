import type { PhysicsParameters } from "../atlasPhysics";
import { continuumProperties } from "../liverContinuumMaterial";

export interface LogVolumeEvaluation {
  /** Incremental energy correction, J/m³ = Pa. J itself is dimensionless. */
  energyDensity: number;
  firstDerivativePa: number;
  secondDerivativePa: number;
}

export const LOG_VOLUME_PROVENANCE = Object.freeze({
  model: "compressible-log-neo-hookean-equilibrium-with-existing-green-maxwell-branches",
  source: "https://febiosoftware.github.io/febio-docs/features/features/solid_material_neo-hookean/",
  smallStrainMatched: true,
  finiteStrainCalibrated: false,
  scope: "Cutting-only constitutive choice; the elasticity learner does not identify this large-strain law.",
});

/** Replace the stable-NH equilibrium volumetric potential with canonical log-NH.
 * The unchanged I1 term and Maxwell branches are supplied elsewhere.
 * This is an energy difference, NOT an extra tunable compression penalty.
 *
 * Stable: -mu (J-1) + (K+mu/3)/2 (J-1)^2
 * Log:    -mu log J + (K-2mu/3)/2 (log J)^2
 * Their value, first derivative and second derivative agree at J=1. Thus the
 * existing infinitesimal bulk/shear moduli are retained; large-strain behavior
 * changes and requires its own calibration. Do not modify shared tissue code.
 */
export function createLogVolumeCorrection(parameters: PhysicsParameters) {
  const { young_pa: young, poisson, relaxation_fraction: fraction } = parameters;
  if (!Number.isFinite(young) || young <= 0 || !Number.isFinite(poisson) || poisson < 0 || poisson >= .5
    || !Number.isFinite(fraction) || fraction < 0 || fraction >= 1) {
    throw new Error("Log-volume tissue requires positive finite E, 0 <= Poisson < 0.5 and 0 <= relaxation fraction < 1");
  }
  const { bulk, muEquilibrium } = continuumProperties(parameters);
  const rawLambdaLog = bulk - 2 * muEquilibrium / 3;
  // The validated parameter domain makes lambda nonnegative analytically.
  // At nu = 0 and g = 0, subtracting equivalent moduli can leave a negative
  // rounding residue. Clamp only that residue; preserve all positive values
  // bit for bit so the qualified default material is unchanged.
  const coefficientRoundoff = 8 * Number.EPSILON * Math.max(bulk, muEquilibrium);
  const lambdaLog = rawLambdaLog < 0 && rawLambdaLog >= -coefficientRoundoff ? 0 : rawLambdaLog;
  const lambdaStable = bulk + muEquilibrium / 3;
  if (![bulk, muEquilibrium, lambdaLog, lambdaStable].every(Number.isFinite) || bulk <= 0 || muEquilibrium <= 0 || lambdaLog < 0) {
    throw new Error("Invalid logarithmic equilibrium coefficients");
  }
  return Object.freeze({
    bulk, muEquilibrium, lambdaLog, lambdaStable,
    evaluate(jacobian: number, out: LogVolumeEvaluation = { energyDensity: 0, firstDerivativePa: 0, secondDerivativePa: 0 }): LogVolumeEvaluation {
      if (!Number.isFinite(jacobian) || jacobian <= 0) throw new Error("Log-volume Jacobian must be positive and finite");
      const delta = jacobian - 1, logJ = Math.log(jacobian);
      // Rest is exactly zero, including the correction tangent. The material
      // still has its nonzero original tangent supplied by the bulk evaluator.
      const energyDensity = jacobian === 1 ? 0 : -muEquilibrium * logJ + .5 * lambdaLog * logJ * logJ
        + muEquilibrium * delta - .5 * lambdaStable * delta * delta;
      const firstDerivativePa = jacobian === 1 ? 0 : (-muEquilibrium + lambdaLog * logJ) / jacobian
        + muEquilibrium - lambdaStable * delta;
      const secondDerivativePa = jacobian === 1 ? 0 : (muEquilibrium + lambdaLog * (1 - logJ)) / (jacobian * jacobian) - lambdaStable;
      if (!Number.isFinite(energyDensity) || !Number.isFinite(firstDerivativePa) || !Number.isFinite(secondDerivativePa)) throw new Error("Log-volume response overflow");
      out.energyDensity = energyDensity; out.firstDerivativePa = firstDerivativePa; out.secondDerivativePa = secondDerivativePa;
      return out;
    },
  });
}
