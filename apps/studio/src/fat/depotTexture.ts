import { createOmentalDepotField } from "./depotFields";

export interface OmentalTextureDomain { seed: number; widthMm: number; heightMm: number }
/** Linear, nonperiodic RGBA: lipid coverage, visible vessel path, membrane,
 * opaque alpha. Gross shape and this map share the same continuous depot field.
 * The finer footprint resolves vessel paths without increasing mesh density.
 * These authored paths are neither a vessel segmentation nor a diameter estimate.
 */
export function bakeDepotRegionTexture(domain: OmentalTextureDomain, resolution = 512): Uint8Array {
  if (!Number.isInteger(resolution) || resolution < 16 || resolution > 1024) throw new RangeError("Depot texture resolution must be an integer from 16 to 1024");
  const field = createOmentalDepotField(domain.seed, domain.widthMm, domain.heightMm, {
    vesselFootprintMm: Math.max(.06, Math.max(domain.widthMm, domain.heightMm) / resolution * .48),
  });
  const pixels = new Uint8Array(resolution * resolution * 4);
  for (let y = 0; y < resolution; y++) for (let x = 0; x < resolution; x++) {
    const value = field.sample((x + .5) / resolution, (y + .5) / resolution), offset = (y * resolution + x) * 4;
    pixels[offset] = Math.round(value.lipidCoverage * 255);
    pixels[offset + 1] = Math.round(value.vesselMask * 255);
    pixels[offset + 2] = Math.round(value.membraneCoverage * 255);
    pixels[offset + 3] = 255;
  }
  return pixels;
}
