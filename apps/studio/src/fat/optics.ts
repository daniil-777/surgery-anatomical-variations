/** Authored real-time diffusion surrogate, NOT a fitted BSSRDF or measured RGB spectrum.
 * Redistributes a reserved fraction of direct diffuse response between a normalized
 * wrap lobe and a thickness-attenuated back lobe. Specular interfaces remain separate.
 * The angular integral over a sphere equals Lambert's pi for every thickness/channel;
 * this bounds the lobe budget but does not prove reciprocal volumetric transport. */
export const FAT_OPTICS = Object.freeze({
  version: "viscera-fat-diffuse-surrogate-v1",
  strength: .5,
  wrap: .35,
  attenuationLengthsMm: [4.2, 2.4, 1.35] as readonly [number, number, number],
  thicknessDefinition: "Geometry-derived thickness proxy; not an optical ray path. Affine preview scales it by the loading-axis stretch.",
  interfaceDefinition: "Outgoing view-normal Schlick interface, independently bounded; no reflective light/view half vector on the back lobe.",
});

/** Three r186's optimized Schlick approximation at the outgoing interface.
 * Using n·v avoids the undefined reflective half vector when light opposes view.
 * f0 is the physical material's dielectric normal-incidence reflectance. */
export function fatOutgoingInterface(viewCosine: number, f0 = .04): number {
  if (!Number.isFinite(viewCosine) || viewCosine < 0 || viewCosine > 1 || !Number.isFinite(f0) || f0 < 0 || f0 > 1) throw new RangeError("Invalid outgoing optical interface");
  const fresnel = 2 ** ((-5.55473 * viewCosine - 6.98316) * viewCosine);
  return (1 - f0) * (1 - fresnel);
}

/** CPU reference for numerical integration, limiting-case and parameter experiments. */
export function fatDiffuseLobe(cosine: number, thicknessMm: number, strength: number = FAT_OPTICS.strength): [number, number, number] {
  if (!Number.isFinite(cosine) || cosine < -1 || cosine > 1 || !Number.isFinite(thicknessMm) || thicknessMm < 0 || !Number.isFinite(strength) || strength < 0 || strength > 1) {
    throw new RangeError("Diffuse response requires cosine [-1,1], nonnegative thickness and strength [0,1]");
  }
  const front = Math.max(cosine, 0), back = Math.max(-cosine, 0);
  const wrap = Math.max(cosine + FAT_OPTICS.wrap, 0) / (1 + FAT_OPTICS.wrap) ** 2;
  return FAT_OPTICS.attenuationLengthsMm.map(length => {
    const transmitted = Math.exp(-thicknessMm / length);
    return (1 - strength) * front + strength * ((1 - transmitted) * wrap + transmitted * back);
  }) as [number, number, number];
}
