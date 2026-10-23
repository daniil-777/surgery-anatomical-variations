import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  ORGAN_BAKE_SCHEMA,
  UNITY_ORGAN_PACKAGE_SCHEMA,
  bakeOrganMeshTextures,
  computeSeamlessSmoothOrganNormals,
  createUnityMetallicSmoothnessImage,
  encodeRgbaToPng,
  evaluateSeamlessOrganPoint,
  exportBakedOrganUnityZip,
  refineCoarseOrganGeometry,
  resolveBakeOrgan,
  samplePeriodicBilinear,
  synthesizeSeamlessOrganTile,
  unwrapOrganMeshToAtlas,
  type RgbaImage,
} from "./organMeshBake";

function makeTestTileWithTrenchAndGlint(width = 64, height = 64): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      // Base warm hepatic color + fine sinusoidal micro-texture + strong border step + diagonal trench
      const fine = 0.03 * Math.sin((x * 2 * Math.PI) / 8) * Math.cos((y * 2 * Math.PI) / 8);
      const borderRamp = (x / width) * 0.22 - (y / height) * 0.18;
      const trench = Math.abs(x - y) < 6 ? -0.22 : 0;
      let r = 0.46 + fine + borderRamp + trench;
      let g = 0.22 + fine * 0.6 + borderRamp * 0.5 + trench * 0.6;
      let b = 0.21 + fine * 0.5 + borderRamp * 0.5 + trench * 0.6;

      // Inject a synthetic purple/cyan VAE glint spike at (16, 16) and cyan red-dip at (24, 24)
      if (Math.hypot(x - 16, y - 16) < 2.5) {
        r = 0.58;
        g = 0.44;
        b = 0.62;
      }
      if (Math.hypot(x - 24, y - 24) < 2.5) {
        r = 0.31;
        g = 0.34;
        b = 0.38;
      }

      data[idx] = Math.max(0, Math.min(255, Math.round(r * 255)));
      data[idx + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
      data[idx + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
      data[idx + 3] = 255;
    }
  }
  return { width, height, data };
}

describe("resolveBakeOrgan", () => {
  it("resolves direct atlas organs and tissue-family fallbacks", () => {
    expect(resolveBakeOrgan("liver")).toBe("liver");
    expect(resolveBakeOrgan("liver_peritoneum")).toBe("liver");
    expect(resolveBakeOrgan("gastric_mucosa")).toBe("stomach");
    expect(resolveBakeOrgan("colonic_mucosa")).toBe("large_bowel");
    expect(resolveBakeOrgan("intestinal_mucosa")).toBe("small_bowel");
    expect(resolveBakeOrgan("pancreas_mesentery")).toBe("pancreas");
    expect(resolveBakeOrgan("spleen")).toBe("spleen");
    expect(resolveBakeOrgan("uterus")).toBeUndefined();
    expect(resolveBakeOrgan(undefined)).toBeUndefined();
  });
});

describe("synthesizeSeamlessOrganTile", () => {
  it("eliminates purple/cyan glint outliers, flattens macro trenches, and harmonizes periodic borders", () => {
    const raw = makeTestTileWithGlintAndTrench();
    const result = synthesizeSeamlessOrganTile(raw);
    expect(result.image.width).toBe(raw.width);
    expect(result.image.height).toBe(raw.height);
    expect(result.normal.width).toBe(raw.width);
    expect(result.roughness.width).toBe(raw.width);

    // Check that no pixel in the synthesized tile has purple excess (B > G + 0.03) or cyan red-dip (G > R)
    const out = result.image.data;
    for (let i = 0; i < out.length; i += 4) {
      const r = out[i]! / 255;
      const g = out[i + 1]! / 255;
      const b = out[i + 2]! / 255;
      expect(r).toBeGreaterThan(g + 0.08);
      expect(b).toBeLessThan(g + 0.03);
    }

    // Check periodic boundary continuity: wrap step across x=0..w-1 and y=0..h-1 is small and smooth
    const w = result.image.width;
    const h = result.image.height;
    let wrapDiffX = 0;
    for (let y = 0; y < h; y++) {
      const i0 = (y * w + 0) * 4;
      const i1 = (y * w + (w - 1)) * 4;
      wrapDiffX += Math.abs(out[i0]! - out[i1]!) / 255;
    }
    wrapDiffX /= h;
    expect(wrapDiffX).toBeLessThan(0.03);
  });
});

function makeTestTileWithGlintAndTrench() {
  return makeTestTileWithTrenchAndGlint(64, 64);
}

describe("unwrapOrganMeshToAtlas & bakeOrganMeshTextures", () => {
  it("welds coincident split-seam vertices and smooths staircase normals without altering 3D positions", () => {
    const box = new THREE.BoxGeometry(20, 20, 20);
    const origPos = Array.from(box.getAttribute("position").array);
    computeSeamlessSmoothOrganNormals(box, 8);
    expect(Array.from(box.getAttribute("position").array)).toEqual(origPos);
    const posAttr = box.getAttribute("position");
    const normAttr = box.getAttribute("normal");
    // BoxGeometry duplicates corner vertices across 3 faces with orthogonal normals;
    // after computeSeamlessSmoothOrganNormals, coincident corners must share identical normals.
    for (let i = 0; i < posAttr.count; i++) {
      for (let j = i + 1; j < posAttr.count; j++) {
        if (
          Math.abs(posAttr.getX(i) - posAttr.getX(j)) < 1e-4 &&
          Math.abs(posAttr.getY(i) - posAttr.getY(j)) < 1e-4 &&
          Math.abs(posAttr.getZ(i) - posAttr.getZ(j)) < 1e-4
        ) {
          expect(normAttr.getX(i)).toBeCloseTo(normAttr.getX(j), 5);
          expect(normAttr.getY(i)).toBeCloseTo(normAttr.getY(j), 5);
          expect(normAttr.getZ(i)).toBeCloseTo(normAttr.getZ(j), 5);
        }
      }
    }
    box.dispose();

    // Multi-component organ test: two overlapping capsules sharing an end-to-end junction
    const capA = new THREE.CapsuleGeometry(6, 16, 6, 12);
    const capB = new THREE.CapsuleGeometry(6, 16, 6, 12);
    capB.translate(0, 14, 0);
    const posA = capA.getAttribute("position");
    const posB = capB.getAttribute("position");
    const idxA = capA.getIndex()!;
    const idxB = capB.getIndex()!;
    const mergedPos = new Float32Array((posA.count + posB.count) * 3);
    mergedPos.set(posA.array as Float32Array, 0);
    mergedPos.set(posB.array as Float32Array, posA.count * 3);
    const mergedIdx = new Uint32Array(idxA.count + idxB.count);
    mergedIdx.set(idxA.array as Uint16Array, 0);
    for (let i = 0; i < idxB.count; i++) mergedIdx[idxA.count + i] = idxB.getX(i) + posA.count;
    const multi = new THREE.BufferGeometry();
    multi.setAttribute("position", new THREE.BufferAttribute(mergedPos, 3));
    multi.setIndex(new THREE.BufferAttribute(mergedIdx, 1));
    computeSeamlessSmoothOrganNormals(multi, 10, true);
    const multiNorm = multi.getAttribute("normal");
    for (let i = 0; i < multiNorm.count; i++) {
      const len = Math.hypot(multiNorm.getX(i), multiNorm.getY(i), multiNorm.getZ(i));
      expect(len).toBeCloseTo(1, 3);
    }
    capA.dispose();
    capB.dispose();
    multi.dispose();
  });

  it("unwraps a 3D organ mesh into 6 non-overlapping UV charts and bakes 100% seam-continuous atlases", async () => {
    const sphere = new THREE.SphereGeometry(35, 16, 12);
    const unwrapped = unwrapOrganMeshToAtlas(sphere);
    expect(unwrapped.charts).toHaveLength(6);
    expect(unwrapped.triangleCount).toBeGreaterThan(100);
    expect(unwrapped.crossChartSeamEdges.length).toBeGreaterThan(10);

    const uvAttr = unwrapped.geometry.getAttribute("uv");
    for (let i = 0; i < uvAttr.count; i++) {
      const u = uvAttr.getX(i);
      const v = uvAttr.getY(i);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }

    // Verify that evaluateSeamlessOrganPoint is continuous across normal octant boundaries (nx = 0)
    const rawTile = makeTestTileWithGlintAndTrench();
    const synth = synthesizeSeamlessOrganTile(rawTile);
    const left = evaluateSeamlessOrganPoint(12.3, -8.4, 19.1, -1e-5, 0.6, 0.8, synth.image, synth.meanSrgb, {
      tileScaleMm: 50,
      blendSharpness: 6,
      variancePreserving: true,
      normalMap: synth.normal,
      roughnessMap: synth.roughness,
    });
    const right = evaluateSeamlessOrganPoint(12.3, -8.4, 19.1, 1e-5, 0.6, 0.8, synth.image, synth.meanSrgb, {
      tileScaleMm: 50,
      blendSharpness: 6,
      variancePreserving: true,
      normalMap: synth.normal,
      roughnessMap: synth.roughness,
    });
    expect(Math.hypot(left.rgb[0] - right.rgb[0], left.rgb[1] - right.rgb[1], left.rgb[2] - right.rgb[2])).toBeLessThan(1e-5);

    const surface = {
      geometry: sphere,
      center: new THREE.Vector3(0, 0, 0),
      radius: 35,
      nodes: ["liver"],
      provenance: {
        assetSha256: "a".repeat(64),
        license: "CC-BY-4.0",
        attribution: "Test fixture",
        units: "assumed mm",
        limitations: [],
        source: "https://example.test",
      },
    };
    const baked = bakeOrganMeshTextures("liver", surface, { substrate: rawTile }, { atlasResolution: 64, tileScaleMm: 48, blendSharpness: 6 });
    try {
      expect(baked.metrics.schema).toBe(ORGAN_BAKE_SCHEMA);
      expect(baked.metrics.organ).toBe("liver");
      expect(baked.metrics.atlasResolution).toBe(64);
      expect(baked.metrics.seamContinuity).toBeGreaterThan(0.999);
      expect(baked.metrics.coverageFraction).toBeGreaterThan(0.15);
      expect(samplePeriodicBilinear(baked.seamlessTile, 0.25, 0.75)[3]).toBeCloseTo(1, 5);

      // Verify Curved PN-Triangle subdivision on coarse meshes (< 6000 vertices)
      const refined = refineCoarseOrganGeometry(sphere, 6000);
      expect(refined.getIndex()!.count).toBe(sphere.getIndex()!.count * 4);
      refined.dispose();

      // Verify Unity MetallicSmoothness conversion (R=0, G=255, B=0, A=255-roughness)
      const ms = createUnityMetallicSmoothnessImage(baked.roughnessAtlas);
      expect(ms.data[0]).toBe(0);
      expect(ms.data[1]).toBe(255);
      expect(ms.data[3]).toBe(255 - baked.roughnessAtlas.data[1]!);

      // Verify PNG encoding signature (\x89PNG\r\n\x1a\n)
      const pngBytes = encodeRgbaToPng(ms);
      expect(Array.from(pngBytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

      // Verify Unity PBR ZIP package export (PK\x03\x04 archive containing GLB, BaseMap, NormalMap, MetallicSmoothness, C# script, and URP mat JSON)
      const zipBytes = await exportBakedOrganUnityZip(baked);
      expect(zipBytes[0]).toBe(0x50); // 'P'
      expect(zipBytes[1]).toBe(0x4b); // 'K'
      expect(zipBytes[2]).toBe(0x03);
      expect(zipBytes[3]).toBe(0x04);
      const zipAscii = new TextDecoder().decode(zipBytes);
      expect(zipAscii).toContain("Assets/Viscera/Liver/liver_baked_organ.glb");
      expect(zipAscii).toContain("Assets/Viscera/Liver/Textures/liver_BaseMap.png");
      expect(zipAscii).toContain("Assets/Viscera/Liver/Textures/liver_NormalMap.png");
      expect(zipAscii).toContain("Assets/Viscera/Liver/Textures/liver_MetallicSmoothness.png");
      expect(zipAscii).toContain("Assets/Viscera/Liver/Editor/VisceraLiverImporter.cs");
      expect(zipAscii).toContain(UNITY_ORGAN_PACKAGE_SCHEMA);
    } finally {
      baked.dispose();
      unwrapped.geometry.dispose();
      sphere.dispose();
    }
  });
});
