import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { referenceBaseColor, referenceOklab, REFERENCE_ORGAN_IDS } from "./referenceColor";
import type { ReferenceColor } from "./atlasMaterial";
import { makeWholeSceneTissueMaterial } from "./wholeSceneMaterials";
import { BASELINE_VARIATION } from "./wholeSceneModel";
const reference: ReferenceColor = { version: "reference-color-1", organ: "liver", source_sha256: "a".repeat(64), mask_sha256: "b".repeat(64), observed_srgb: [.65,.4,.35], mode: "chroma", strength: 1 };
describe("reference colour CPU/browser parity and scene preservation", () => {
  it("matches independently evaluated Python Oklab transfer including gamut compression", () => {
    const cases = [
      {base: [.42,.27,.23], ref: reference, expected: [.46963125689654234,.2373633791754377,.19314766576216194]},
      {base: [.42,.27,.23], ref: {...reference, mode: "color" as const, strength: .7}, expected: [.5791891613967626,.36016025000393026,.31313363790497656]},
      {base: [.9,.8,.7], ref: {...reference, observed_srgb: [.1,.2,.9] as [number,number,number]}, expected: [.737766688494205,.8183534679871278,.999999963094011]},
    ];
    for (const c of cases) referenceBaseColor(c.base as [number,number,number], c.ref).forEach((v,i) => expect(v).toBeCloseTo(c.expected[i]!, 6));
  });
  it("retains authored lightness and gives exact no-op at zero strength", () => {
    const base: [number,number,number] = [.42,.27,.23];
    expect(referenceBaseColor(base, {...reference, strength: 0})).toEqual(base);
    expect(referenceOklab(referenceBaseColor(base, reference))[0]).toBeCloseTo(referenceOklab(base)[0], 7);
    referenceBaseColor(base, {...reference, mode: "color"}).forEach((v,i) => expect(v).toBeCloseTo(reference.observed_srgb[i]!, 6));
  });
  it("changes whole-scene colour without changing finish, restores exactly and rejects wrong organs", () => {
    const part = {id: "liver", category: "digestive" as const, color: "#713630"};
    const volume = new THREE.Data3DTexture(), breath = {value: 0};
    const original = makeWholeSceneTissueMaterial(part, BASELINE_VARIATION, breath, volume);
    const changed = makeWholeSceneTissueMaterial(part, BASELINE_VARIATION, breath, volume, {reference});
    expect(changed.material.color.toArray()).not.toEqual(original.material.color.toArray());
    for (const key of ["roughness", "clearcoat", "clearcoatRoughness", "metalness", "ior", "specularIntensity"] as const) expect(changed.material[key]).toBe(original.material[key]);
    expect(makeWholeSceneTissueMaterial(part, BASELINE_VARIATION, breath, volume).signature).toBe(original.signature);
    expect(JSON.parse(changed.signature).reference_color).toEqual(reference);
    expect(() => makeWholeSceneTissueMaterial({...part, id:"left-kidney"}, BASELINE_VARIATION, breath, volume, {reference})).toThrow();
    expect(REFERENCE_ORGAN_IDS["left-kidney"]).toBe("kidney");
    expect(REFERENCE_ORGAN_IDS.colon).toBe("large-intestine");
  });
});
