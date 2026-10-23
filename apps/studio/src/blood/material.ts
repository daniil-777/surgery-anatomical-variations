/** SI constitutive data. These computational presets are not donor-specific fits. */
export interface CYProfile {
  id: string; rho: number; mu0: number; muInf: number; lambda: number; a: number; n: number; source: string;
}
export const BLOOD_PROFILES: readonly CYProfile[] = [
  { id: "weddell-2015", rho: 1060, mu0: .056, muInf: .00345, lambda: 1.902, a: 1.25, n: .22,
    source: "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0124575" },
  { id: "cho-used-2011", rho: 1060, mu0: .056, muInf: .00345, lambda: 3.313, a: 2, n: .3568,
    source: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3047441/" },
];
export function validateMaterial(p: CYProfile): void {
  for (const k of ["rho", "mu0", "muInf", "lambda", "a", "n"] as const)
    if (!Number.isFinite(p[k]) || p[k] <= 0) throw new RangeError(`Invalid material ${k}`);
  if (p.mu0 < p.muInf || p.n > 1) throw new RangeError("Expected a shear-thinning or constant-viscosity profile");
}
export function viscosity(gamma: number, p = BLOOD_PROFILES[0]!): number {
  validateMaterial(p);
  if (!Number.isFinite(gamma) || gamma < 0 || gamma > 1e6) throw new RangeError("Shear rate outside the evaluated domain [0, 10⁶] s⁻¹");
  return p.muInf + (p.mu0 - p.muInf) * (1 + (p.lambda * gamma) ** p.a) ** ((p.n - 1) / p.a);
}
export function shearRate(g: readonly number[]): number {
  if (g.length !== 9 || g.some(x => !Number.isFinite(x))) throw new RangeError("Expected a finite, row-major 3×3 velocity gradient");
  let sum = 0;
  for (let i = 0; i < 3; ++i) for (let j = 0; j < 3; ++j) sum += ((g[i * 3 + j]! + g[j * 3 + i]!) / 2) ** 2;
  return Math.sqrt(2 * sum);
}
export function surfaceTensionCitrated(temperatureC: number): number {
  if (!Number.isFinite(temperatureC) || temperatureC < 20 || temperatureC > 40) throw new RangeError("Rosina fit applies only at 20–40 °C");
  return (70.105 - .473 * temperatureC) * 1e-3;
}
