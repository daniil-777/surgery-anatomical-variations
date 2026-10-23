/** Versioned numerical policy for the prepared cutting experiment. These are
 * solver tolerances, not learned material properties or clinical thresholds.
 * Changes require trajectory and temporal/spatial sensitivity qualification. */
export const CUTTING_NUMERICS = Object.freeze({
  version: 3,
  defaultEquilibriumModel: "log-neo-hookean" as "stable-neo-hookean" | "log-neo-hookean",
  preconditioner: "block-sparse-continuum-contact-gram-pcg",
  contactIntegration: "exact-affine-cap-finite-prism-penalty",
  surfaceBoundResolutionMm: 1e-5,
  defaultDtSeconds: 1 / 480,
  defaultContactSpacingMm: 2.5,
  maximumStepSeconds: 1 / 30,
  maximumToolSpeedMmS: 30,
  maximumVertexSweeps: 128,
  maximumGlobalIterations: 128,
  maximumNodalResidualN: .001,
  globalTargetResidualN: .0002,
  vertexTargetResidualN: .00025,
  lateVertexTargetResidualN: .00075,
  lateVertexSweep: 48,
  globalStartSweep: 8,
  minimumAcceptedJacobian: .09,
  minimumTrialJacobian: .1,
  maximumPenetrationHalfThicknessFraction: .1,
  maximumStepRetries: 5,
  contactPenaltyPaPerM: 8e11,
  fixtureStiffnessNPerM: 1000,
  contactSideTieM: 1e-12,
});
