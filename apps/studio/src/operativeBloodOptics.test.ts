import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClampToEdgeWrapping, FloatType, NearestFilter, NoColorSpace, Texture } from "three";
import { bloodAppearanceTransport } from "./blood/experiments/bloodAppearanceOptics";
import {
  APPEARANCE_LOG_MAX, APPEARANCE_LUT_BASE64, APPEARANCE_SCALE_M,
} from "./blood/experiments/bloodAppearanceLut.generated";
import {
  createOperativeBloodTransportTexture, operativeBloodComposite, operativeBloodTexture, operativeBloodTransportTextureData,
  OPERATIVE_BLOOD_OXYGENATION, OPERATIVE_BLOOD_PROVENANCE, OPERATIVE_BLOOD_TRANSPORT_WIDTH,
} from "./operativeBloodOptics";

describe("operative blood surface optics", () => {
  it("retains the attributed spectral artifact rather than fitting red RGB constants", () => {
    const attribution = JSON.parse(readFileSync(new URL("../public/blood-optics-attribution.json", import.meta.url), "utf8"));
    expect(createHash("sha256").update(Buffer.from(APPEARANCE_LUT_BASE64, "base64")).digest("hex"))
      .toBe(attribution.experimentalAppearance.validation.storedSha256);
    expect(attribution.operativeSceneAppearance.parentModel).toBe(OPERATIVE_BLOOD_PROVENANCE.sourceModel);
    expect(attribution.operativeSceneAppearance.derivedDataLicense.identifier).toBe("CC-BY-SA-4.0");
    expect(OPERATIVE_BLOOD_PROVENANCE.limitations).toContain("Appearance only");
    expect(OPERATIVE_BLOOD_OXYGENATION).toBe(.75);
  });

  it("preserves a dry substrate exactly and converts scene millimetres to optical metres", () => {
    const substrate = [.62, .28, .16] as const;
    expect(operativeBloodComposite(0, substrate)).toEqual(substrate);
    const black = operativeBloodComposite(1, [0, 0, 0]);
    expect(black).toEqual(bloodAppearanceTransport(.001, .75).reflectance);
    expect(operativeBloodComposite(50, substrate)).toEqual(operativeBloodComposite(1e6, substrate));
    expect(operativeBloodComposite(.002, substrate)[0]).toBeGreaterThan(operativeBloodComposite(1, substrate)[0]);
  });

  it("is passive on black, gray, tissue-colored and white substrates across thin and thick films", () => {
    for (const substrate of [[0, 0, 0], [.18, .18, .18], [.62, .28, .16], [1, 1, 1]] as const)
      for (const thickness of [0, 1e-9, .001, .01, .1, 1, 10, 50]) {
        const color = operativeBloodComposite(thickness, substrate);
        expect(color.every(c => Number.isFinite(c) && c >= 0 && c <= 1)).toBe(true);
        const { reflectance: r } = bloodAppearanceTransport(thickness * .001, .75);
        for (let c = 0; c < 3; c++) expect(color[c]).toBeGreaterThanOrEqual(r[c]! - 1e-12);
      }
  });

  it("packs separate passive R/T rows and matches off-node spectral interpolation", () => {
    const width = OPERATIVE_BLOOD_TRANSPORT_WIDTH, data = operativeBloodTransportTextureData();
    expect(data.byteLength).toBe(16384);
    expect(Array.from(data.slice(0, 4))).toEqual([0, 0, 0, 1]);
    expect(Array.from(data.slice(width * 4, width * 4 + 4))).toEqual([1, 1, 1, 1]);
    for (let i = 0; i < width - 1; i += 7) {
      const fraction = .37;
      const thicknessM = APPEARANCE_SCALE_M * Math.expm1(APPEARANCE_LOG_MAX * (i + fraction) / (width - 1));
      const expected = bloodAppearanceTransport(thicknessM, .75);
      for (const [row, channels] of [[0, expected.reflectance], [1, expected.transmittance]] as const) {
        for (let c = 0; c < 3; c++) {
          const base = (row * width + i) * 4 + c;
          const interpolated = data[base]! * (1 - fraction) + data[base + 4]! * fraction;
          expect(Math.abs(interpolated - channels[c]!)).toBeLessThan(1e-7);
        }
      }
    }
  });

  it("uses a bounded linear-data GPU texture without float filtering or mip requirements", () => {
    const texture = createOperativeBloodTransportTexture();
    expect([texture.image.width, texture.image.height]).toEqual([512, 2]);
    expect(texture.type).toBe(FloatType);
    expect(texture.colorSpace).toBe(NoColorSpace);
    expect(texture.minFilter).toBe(NearestFilter);
    expect(texture.magFilter).toBe(NearestFilter);
    expect(texture.wrapS).toBe(ClampToEdgeWrapping);
    expect(texture.wrapT).toBe(ClampToEdgeWrapping);
    expect(texture.generateMipmaps).toBe(false);
    expect(texture.version).toBe(1);
    expect(texture.userData.provenance.oxygenationFraction).toBe(.75);
    let disposed = false;
    texture.addEventListener("dispose", () => { disposed = true; });
    texture.dispose();
    expect(disposed).toBe(true);
  });

  it("shares a texture across materials and releases it once with its scene owner", () => {
    const owner = new Texture(), otherOwner = new Texture();
    const texture = operativeBloodTexture(owner), other = operativeBloodTexture(otherOwner);
    expect(operativeBloodTexture(owner)).toBe(texture);
    expect(other).not.toBe(texture);
    let disposed = 0, otherDisposed = 0;
    texture.addEventListener("dispose", () => { disposed++; });
    other.addEventListener("dispose", () => { otherDisposed++; });
    owner.dispose(); owner.dispose();
    expect(disposed).toBe(1);
    expect(otherDisposed).toBe(0);
    const replacement = operativeBloodTexture(owner);
    expect(replacement).not.toBe(texture);
    owner.dispose(); otherOwner.dispose();
    expect(otherDisposed).toBe(1);
  });

  it("rejects invalid units, oxygenation and substrate values", () => {
    for (const value of [-1, NaN, Infinity]) expect(() => operativeBloodComposite(value, [.5, .5, .5])).toThrow(RangeError);
    for (const value of [-.01, 1.01, NaN, Infinity]) {
      expect(() => createOperativeBloodTransportTexture(value)).toThrow(RangeError);
      expect(() => operativeBloodComposite(0, [.5, .5, .5], value)).toThrow(RangeError);
    }
    expect(() => operativeBloodComposite(.1, [1.1, .5, .5])).toThrow(RangeError);
    expect(() => operativeBloodComposite(.1, [.5, NaN, .5])).toThrow(RangeError);
  });
});
