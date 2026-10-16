import { Color } from "three";
import type { OrganMesh } from "./types";

/** Preserve intrinsic pigment while allowing a user-selected material tint. */
export function pigmentModulation(organ: OrganMesh): Float32Array {
  const result = new Float32Array(organ.positions.length).fill(1);
  // Imported surfaces without a pigment artifact receive neutral modulation.
  // Invalid artifacts are rejected by the caller; never invent spatial noise.
  if (organ.colors === undefined) return result;
  if (
    organ.colors.length !== result.length ||
    organ.colors.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 1,
    )
  ) {
    throw new Error(
      `${organ.name}: pigment must contain one finite sRGB triplet in [0, 1] per vertex.`,
    );
  }
  const base = new Color(organ.color).toArray();
  const sample = new Color();
  for (let i = 0; i < result.length; i += 3) {
    sample
      .setRGB(organ.colors[i]!, organ.colors[i + 1]!, organ.colors[i + 2]!)
      .convertSRGBToLinear();
    const linear = sample.toArray();
    for (let channel = 0; channel < 3; channel++) {
      // A black source channel cannot encode a relative tint; keep it neutral.
      result[i + channel] =
        base[channel]! > 1e-8 ? linear[channel]! / base[channel]! : 1;
    }
  }
  return result;
}
