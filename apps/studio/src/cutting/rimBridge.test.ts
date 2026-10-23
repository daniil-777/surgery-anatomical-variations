import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readCuttingReference, updateCuttingSkin } from "./reference";
import { createCuttingRimBridge, updateCuttingRimBridge, RIM_BRIDGE_PROVENANCE } from "./rimBridge";

const mesh = readCuttingReference(JSON.parse(readFileSync(new URL("../../public/cutting/liver-reference.json", import.meta.url), "utf8")));
const bridge = createCuttingRimBridge(mesh);
function buffers() {
  return { positions: new Float32Array(bridge.skinVertices.length * 3), normals: new Float32Array(bridge.skinVertices.length * 3), indices: new Uint32Array(bridge.skinVertices.length), skin: new Float32Array(mesh.skin.positionsMm), skinNormals: new Float32Array(mesh.skin.positionsMm.length).fill(.25), damage: new Float64Array(mesh.seamPairs.length) };
}
describe("intact cohesive rim visualization", () => {
  it("pairs the complete actual skin rim and follows both deformed endpoints without mechanical forces", () => {
    expect(bridge.damagePairs).toHaveLength(228); expect(bridge.skinVertices.length).toBe(228 * 6);
    expect(RIM_BRIDGE_PROVENANCE.mechanicalContribution).toBe(false);
    const b = buffers(), moved = [...mesh.positionsMm];
    for (const pair of mesh.seamPairs) moved[pair.right * 3]! += .02;
    updateCuttingSkin(mesh, moved, b.skin);
    expect(updateCuttingRimBridge(bridge, b.skin, b.skinNormals, b.damage, b.positions, b.normals, b.indices)).toBe(b.indices.length);
    bridge.skinVertices.forEach((v, i) => { for (let a = 0; a < 3; a++) { expect(b.positions[i * 3 + a]).toBe(b.skin[v * 3 + a]); expect(b.normals[i * 3 + a]).toBe(b.skinNormals[v * 3 + a]); } });
    expect(b.damage.every(d => d === 0)).toBe(true);
  });
  it("never conceals even incipient damage and restores only when the actual state is reset", () => {
    const b = buffers(), pair = bridge.damagePairs[0]![0]!; b.damage[pair] = 1e-12;
    const expected = bridge.damagePairs.filter(p => !p.includes(pair)).length * 6;
    const count = updateCuttingRimBridge(bridge, b.skin, b.skinNormals, b.damage, b.positions, b.normals, b.indices);
    expect(count).toBe(expected); expect(count).toBeLessThan(b.indices.length); expect(count).toBeGreaterThan(0);
    for (const i of b.indices.slice(0, count)) expect(bridge.damagePairs[Math.floor(i / 6)]).not.toContain(pair);
    b.damage.fill(1); expect(updateCuttingRimBridge(bridge, b.skin, b.skinNormals, b.damage, b.positions, b.normals, b.indices)).toBe(0);
    b.damage.fill(0); expect(updateCuttingRimBridge(bridge, b.skin, b.skinNormals, b.damage, b.positions, b.normals, b.indices)).toBe(b.indices.length);
    b.damage[0] = NaN; expect(() => updateCuttingRimBridge(bridge, b.skin, b.skinNormals, b.damage, b.positions, b.normals, b.indices)).toThrow(/finite damage/);
  });
  it("refuses incomplete topology or contradictory interpolation instead of covering selected edges", () => {
    const missing = structuredClone(mesh), rimVertex = bridge.skinVertices[0]!;
    missing.skin.indices = missing.skin.indices.filter((_, i, a) => !a.slice(Math.floor(i / 3) * 3, Math.floor(i / 3) * 3 + 3).includes(rimVertex));
    expect(() => createCuttingRimBridge(missing)).toThrow(/paired cohesive rim/);
    const wrong = structuredClone(mesh); wrong.skin.weights[rimVertex * 4] = .5;
    expect(() => createCuttingRimBridge(wrong)).toThrow(/paired cohesive rim/);
  });
});
