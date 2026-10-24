import { describe, expect, it } from "vitest";
import { BufferAttribute, PlaneGeometry, Vector3 } from "three";
import { buildVascularTable, periodicTissueNoise, updateTissueTangents } from "./tissueDetail";

describe("surface vascular detail", () => {
  it("keeps tissue noise continuous at cell and texture-tile boundaries", () => {
    for (const frequency of [13, 97]) for (const t of [.0, .17, .51, .98]) {
      expect(periodicTissueNoise(0,t,frequency,42)).toBe(periodicTissueNoise(1,t,frequency,42));
      expect(periodicTissueNoise(t,0,frequency,42)).toBe(periodicTissueNoise(t,1,frequency,42));
      const boundary=3/frequency;
      expect(Math.abs(periodicTissueNoise(boundary-1e-7,t,frequency,42)-periodicTissueNoise(boundary+1e-7,t,frequency,42))).toBeLessThan(1e-5);
    }
  });
  it("replays a seed and changes branching, not just the texture offset, for another seed", () => {
    const a = buildVascularTable(42, 128), b = buildVascularTable(42, 128), c = buildVascularTable(43, 128);
    expect(a).toEqual(b);
    expect(a.arteryMask).not.toEqual(c.arteryMask);
    expect(a.veinMask).not.toEqual(a.arteryMask);
    for (const field of Object.values(a)) expect(field.every(Number.isFinite)).toBe(true);
  });

  it("keeps the visible vascular trunks connected across periodic borders and leaves exposed tissue", () => {
    const side = 128, fields = buildVascularTable(42, side);
    for (const field of [fields.arteryMask, fields.veinMask]) {
      const seen = new Uint8Array(field.length), components: number[] = [];
      for (let at = 0; at < field.length; at++) {
        if (seen[at] || field[at]! < 0.15) continue;
        const queue = [at]; seen[at] = 1;
        for (let i = 0; i < queue.length; i++) {
          const p = queue[i]!, x = p % side, y = Math.floor(p / side);
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const q = ((y + dy + side) % side) * side + (x + dx + side) % side;
            if (!seen[q] && field[q]! >= 0.15) { seen[q] = 1; queue.push(q); }
          }
        }
        components.push(queue.length);
      }
      components.sort((a, b) => b - a);
      const total = components.reduce((sum, n) => sum + n, 0);
      expect(total).toBeGreaterThan(side * side * 0.01);
      expect(total).toBeLessThan(side * side * 0.18);
      expect((components[0]! + (components[1] ?? 0)) / total).toBeGreaterThan(0.94);
    }
  });

  it("rebuilds a stale tangent to match a rotated UV layout, including handedness", () => {
    const geometry = new PlaneGeometry(2, 2);
    const uv = geometry.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) { const u = uv.getX(i); uv.setXY(i, uv.getY(i), u); }
    geometry.setAttribute("tangent", new BufferAttribute(new Float32Array(uv.count * 4).fill(1), 4));
    updateTissueTangents(geometry);
    const tangent = geometry.getAttribute("tangent");
    for (let i = 0; i < tangent.count; i++) {
      expect(new Vector3().fromBufferAttribute(tangent, i).distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-6);
      expect(tangent.getW(i)).toBe(-1);
    }
    geometry.dispose();
  });
});
