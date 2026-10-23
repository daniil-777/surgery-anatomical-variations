import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { CuttingEmbeddedSurface, CuttingReference } from "./types";
import { readCuttingReference, updateCuttingSkin, updateCuttingSurface } from "./reference";

const fixture = (): CuttingReference => ({
  schema: "viscera.cutting-reference/v1", source: { templateId: "two-tets", sha256: "test-fixture", attribution: "Analytic paired tetrahedra", license: "CC0" },
  positionsMm: [-1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0],
  tets: [0, 1, 2, 3, 4, 7, 5, 6], boundaryIndices: [0, 1, 2, 4, 7, 5], seamPairs: [{ left: 1, right: 4, areaM2: 1 / 6e6 }, { left: 2, right: 5, areaM2: 1 / 6e6 }, { left: 3, right: 6, areaM2: 1 / 6e6 }], seamLeftIndices: [1, 2, 3], seamRightIndices: [4, 6, 5],
  skin: { positionsMm: [-1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2, 3, 4, 5], colors: Array(18).fill(.5), tetIndices: [0, 0, 0, 1, 1, 1], weights: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] },
  planeXMm: 0, floorYMm: -2, fixedNodes: [0], diagnostics: { originalCageVolumeM3: 1 / 3e9, splitVolumeM3: 1 / 3e9, seamAreaM2: .5e-6, embeddingErrorMm: 0, minimumTetVolumeM3: 1 / 6e9 }, limitations: ["Synthetic fixture"],
});

describe("cutting reference and capsule embedding", () => {
  it("loads the published liver artifact with consistent side ownership and interface area", () => {
    const mesh = readCuttingReference(JSON.parse(readFileSync(new URL("../../public/cutting/liver-reference.json", import.meta.url), "utf8")));
    expect(mesh.source.templateId).toBe("hra-liver-female"); expect(mesh.skin.positionsMm.length / 3).toBeGreaterThan(15000);
    const output = new Float32Array(mesh.skin.positionsMm.length); updateCuttingSkin(mesh, mesh.positionsMm, output);
    let maximumError = 0; for (let i = 0; i < output.length; i++) maximumError = Math.max(maximumError, Math.abs(output[i]! - mesh.skin.positionsMm[i]!));
    expect(maximumError).toBeLessThan(1e-5);
  });
  it("keeps the two capsule sides disconnected while rigid motion follows the mechanics exactly", () => {
    const mesh = readCuttingReference(fixture()), output = new Float32Array(mesh.skin.positionsMm.length);
    const moved = mesh.positionsMm.map((value, index) => value + [4, -3, 2][index % 3]!); updateCuttingSkin(mesh, moved, output);
    mesh.skin.positionsMm.forEach((value, index) => expect(output[index]).toBeCloseTo(value + [4, -3, 2][index % 3]!, 6));
    // An opening on the right cannot drag the left capsule through a shared index.
    for (let node = 4; node < 8; node++) moved[node * 3]! += 2;
    updateCuttingSkin(mesh, moved, output); expect(output[0]).toBe(3); expect(output[9]).toBe(6);
  });
  it("rejects bridging triangles, invalid pair membership and non-affine embedding", () => {
    const bridge = fixture(); bridge.skin.indices = [0, 4, 2]; expect(() => readCuttingReference(bridge)).toThrow();
    const pair = fixture(); pair.seamPairs[1]!.right = 4; expect(() => readCuttingReference(pair)).toThrow();
    const weights = fixture(); weights.skin.weights[0] = .8; expect(() => readCuttingReference(weights)).toThrow();
    const colour = fixture(); colour.skin.colors[0] = Infinity; expect(() => readCuttingReference(colour)).toThrow();
    const wrongHalf = fixture(); wrongHalf.skin.tetIndices[1] = 1; wrongHalf.skin.weights.splice(4, 4, 1, 0, 0, 0); expect(() => readCuttingReference(wrongHalf)).toThrow();
    const area = fixture(); area.seamPairs[0]!.areaM2 *= 2; expect(() => readCuttingReference(area)).toThrow();
    expect(() => updateCuttingSkin(fixture(), [], new Float32Array(18))).toThrow();
  });
  it("validates outward cut faces and follows each deformed half without bridging", () => {
    const mesh = fixture();
    mesh.cap = { positionsMm: [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0], indices: [0, 1, 2, 3, 4, 5], tetIndices: [0, 0, 0, 1, 1, 1], weights: [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0] };
    readCuttingReference(mesh);
    const compact=structuredClone(mesh);compact.contactCap=structuredClone(mesh.cap);
    expect(readCuttingReference(compact).contactCap).toEqual(mesh.cap);
    const missing=structuredClone(compact);delete missing.cap;expect(()=>readCuttingReference(missing)).toThrow();
    const wrongArea=structuredClone(compact);wrongArea.contactCap!.indices.push(0,1,2);expect(()=>readCuttingReference(wrongArea)).toThrow();
    const wrongEmbedding=structuredClone(compact);wrongEmbedding.contactCap!.weights[0]=.2;expect(()=>readCuttingReference(wrongEmbedding)).toThrow();
    const moved = [...mesh.positionsMm], output = new Float32Array(18);
    for (let node = 4; node < 8; node++) moved[node * 3]! += 2;
    updateCuttingSurface(mesh, mesh.cap, moved, output);
    expect(Array.from(output).filter((_, i) => i % 3 === 0)).toEqual([0, 0, 0, 2, 2, 2]);
    const reversed = structuredClone(mesh); reversed.cap!.indices = [0, 2, 1, 3, 4, 5]; expect(() => readCuttingReference(reversed)).toThrow();
    const outside = structuredClone(mesh); outside.cap!.positionsMm[1] = 10; expect(() => readCuttingReference(outside)).toThrow();
    const mixed = structuredClone(mesh); mixed.cap!.indices = [0, 1, 4, 3, 4, 5]; expect(() => readCuttingReference(mixed)).toThrow();
  });
  it("rejects a contact cap that preserves all quadratic moments but omits half the domain", () => {
    const mesh = fixture();
    function surface(altered: boolean, parityOnly?: 0 | 1): CuttingEmbeddedSurface {
      const positionsMm: number[] = [], indices: number[] = [], tetIndices: number[] = [], weights: number[] = [];
      // Third finite differences annihilate all degree <= 2 moments. Duplicating
      // even-parity tiles and omitting odd-parity tiles therefore evades area,
      // centroid and inertia checks while changing localized contact forces.
      for (const side of [0, 1]) for (let mask = 0; mask < 8; mask++) {
        const a = mask & 1, b = (mask >> 1) & 1, c = (mask >> 2) & 1;
        if (parityOnly !== undefined && (a + b + c) % 2 !== parityOnly) continue;
        const copies = altered ? ((a + b + c) % 2 === 0 ? 2 : 0) : 1;
        const y = .1 + .08 * a + .16 * c, z = .1 + .08 * b + .16 * c;
        for (let copy = 0; copy < copies; copy++) {
          const start = positionsMm.length / 3;
          for (const [yy, zz] of [[y, z], [y + .02, z], [y, z + .02]]) {
            positionsMm.push(0, yy!, zz!); tetIndices.push(side);
            weights.push(...(side === 0 ? [0, 1 - yy! - zz!, yy!, zz!] : [1 - yy! - zz!, 0, yy!, zz!]));
          }
          indices.push(...(side === 0 ? [start, start + 1, start + 2] : [start, start + 2, start + 1]));
        }
      }
      return { positionsMm, indices, tetIndices, weights };
    }
    mesh.cap = surface(false); mesh.contactCap = structuredClone(mesh.cap);
    expect(() => readCuttingReference(mesh)).not.toThrow();
    mesh.contactCap = surface(true);
    expect(() => readCuttingReference(mesh)).toThrow(/overlapping triangles/);
    // Even/odd subsets also have identical moments, with NO self-overlap on
    // either side. This requires actual domain intersection, not just an
    // overlap check added to the old moment contract.
    mesh.cap = surface(false, 0); mesh.contactCap = surface(false, 1);
    expect(() => readCuttingReference(mesh)).toThrow(/missing or extra surface area/);
  });
});
