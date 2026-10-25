import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { OrganMesh } from "@viscera/render";
import { applyAtlasVesselColor, ATLAS_VESSEL_VERSION, createAtlasVesselNetwork, evaluateVesselAnchor, sampleAtlasVessels, type AtlasVesselNetwork } from "./atlasVessels";
import { createAtlasVesselGrid, installAtlasVessels } from "./atlasVesselShader";

function sphere(): OrganMesh {
  const geometry = new THREE.SphereGeometry(75, 48, 32);
  return { id: "liver", name: "Liver", kind: "organ", color: "#805040", positions: Array.from(geometry.getAttribute("position").array), indices: Array.from(geometry.index!.array) };
}
function lineNetwork(): AtlasVesselNetwork {
  return { version: ATLAS_VESSEL_VERSION, seed: 42, organ_id: "liver", provenance: "procedural-surface-design-not-patient-vasculature",
    settings: { density: 0.45, visibility: 0.72, radius_scale: 1 }, statistics: { terminals: 1, branches: 0, connected_components: 1, length_mm: 10, murray_exponent: 3 },
    segments: [{ a_mm: [0, 0, 0], b_mm: [10, 0, 0], normal: [0, 0, 1], radius_a_mm: 1, radius_b_mm: 1, depth_mm: 0.5, kind: 0,
      a_anchor: { triangle: 0, weights: [1, 0, 0] }, b_anchor: { triangle: 0, weights: [0, 1, 0] } }] };
}

describe("Surface vascular design", () => {
  it("reduces grid-shaped bends without changing branch topology or detaching endpoints",()=>{
    const organ=sphere(),options={organId:"liver",seed:42},original=createAtlasVesselNetwork(organ,options),smooth=createAtlasVesselNetwork(organ,{...options,fairingPasses:20});
    const bending=(network:AtlasVesselNetwork)=>{
      const incoming=new Map(network.segments.map(s=>[s.b_mm.join(","),s])),outgoing=new Map<string,typeof network.segments>();
      for(const s of network.segments){const key=s.a_mm.join(",");outgoing.set(key,[...(outgoing.get(key)??[]),s]);}
      let sum=0,count=0;for(const [key,children] of outgoing){const parent=incoming.get(key);if(!parent||children.length!==1)continue;
        const a=new THREE.Vector3(...parent.b_mm).sub(new THREE.Vector3(...parent.a_mm)).normalize(),child=children[0]!,b=new THREE.Vector3(...child.b_mm).sub(new THREE.Vector3(...child.a_mm)).normalize();sum+=1-a.dot(b);count++;
      }return sum/count;
    };
    expect(bending(smooth)).toBeLessThan(bending(original)*.8);
    expect(smooth.statistics.branches).toBe(original.statistics.branches);expect(smooth.statistics.terminals).toBe(original.statistics.terminals);
    expect(smooth.statistics.max_junction_murray_relative_error).toBeLessThan(1e-10);
    for(const segment of smooth.segments)for(const end of ["a","b"] as const){const point=evaluateVesselAnchor(segment[`${end}_anchor`],organ.positions,organ.indices);for(let k=0;k<3;k++)expect(point[k]).toBeCloseTo(segment[`${end}_mm`][k]!,5);}
    expect(()=>createAtlasVesselNetwork(organ,{...options,fairingPasses:100})).toThrow("settings");
  });
  it("generates deterministic connected, tapered branches attached to actual triangles", () => {
    const organ = sphere();
    const network = createAtlasVesselNetwork(organ, { organId: "liver", seed: 42 });
    expect(network).toEqual(createAtlasVesselNetwork(organ, { organId: "liver", seed: 42 }));
    expect(network.statistics.connected_components).toBe(1);
    expect(network.statistics.branches).toBeGreaterThan(8);
    expect(network.statistics.terminals).toBeGreaterThan(20);
    expect(network.statistics.fine_terminals).toBeGreaterThan(5);
    expect(network.statistics.max_junction_murray_relative_error).toBeLessThan(1e-10);
    expect(network.segments.length).toBeGreaterThan(100);
    expect(network.segments.length).toBeLessThan(2000);
    for (const segment of network.segments) {
      expect(evaluateVesselAnchor(segment.a_anchor, organ.positions, organ.indices)).toEqual(expect.arrayContaining(segment.a_mm.map(v => expect.closeTo(v, 5))));
      for (let k = 0; k < 3; k++) {
        expect(evaluateVesselAnchor(segment.b_anchor, organ.positions, organ.indices)[k]).toBeCloseTo(segment.b_mm[k]!, 5);
      }
      expect(segment.radius_a_mm).toBeGreaterThanOrEqual(segment.radius_b_mm);
      expect(Math.hypot(...segment.normal)).toBeCloseTo(1, 5);
    }
    const altered = createAtlasVesselNetwork(organ, { organId: "liver", seed: 43 });
    expect(altered.segments).not.toEqual(network.segments);
    const lowDensity = createAtlasVesselNetwork(organ, { organId: "liver", seed: 42, density: 0.1 });
    expect(lowDensity.statistics.terminals).toBeLessThan(network.statistics.terminals);
  });
  it("uses immutable rest positions and keeps attachments under arbitrary sculpture", () => {
    const organ = sphere();
    const before = createAtlasVesselNetwork(organ, { organId: "liver", seed: 42 });
    const edited = { ...organ, positions: organ.positions.map((v, i) => i % 3 === 0 ? v * 1.2 + 15 : v), rest_positions: organ.positions };
    expect(createAtlasVesselNetwork(edited, { organId: "liver", seed: 42 })).toEqual(before);
    const segment = before.segments[5]!;
    const attached = evaluateVesselAnchor(segment.a_anchor, edited.positions, organ.indices);
    expect(attached[0]).toBeCloseTo(segment.a_mm[0] * 1.2 + 15, 5);
    expect(attached[1]).toBeCloseTo(segment.a_mm[1], 5);
  });
  it("refuses malformed geometry and out-of-range settings, and permits an empty layer", () => {
    expect(createAtlasVesselNetwork(sphere(), { organId: "liver", seed: 42, density: 0 }).segments).toEqual([]);
    expect(() => createAtlasVesselNetwork(sphere(), { organId: "liver", seed: 42, density: NaN })).toThrow("settings");
    const bad = sphere(); bad.positions[0] = NaN;
    expect(() => createAtlasVesselNetwork(bad, { organId: "liver", seed: 42 })).toThrow("finite rest");
  });
});

describe("Layered vessel appearance and GPU culling", () => {
  it("matches the analytic axial value, softens at depth and suppresses opposite walls", () => {
    const network = lineNetwork(), sample = sampleAtlasVessels([5, 0, 0], [0, 0, 1], network);
    expect(sample.artery).toBeCloseTo(0.72 * 0.74 * Math.exp(-0.4), 12);
    expect(sample.heightMm).toBeCloseTo(0.072 * Math.exp(-0.4), 12);
    expect(sample.gradient).toEqual([-0, -0, -0]);
    expect(sampleAtlasVessels([5, 0, 0], [0, 0, -1], network).artery).toBe(0);
    expect(sampleAtlasVessels([5, 30, 0], [0, 0, 1], network).artery).toBe(0);
    const softened = sampleAtlasVessels([5, 0, 0], [0, 0, 1], network, 4);
    expect(softened.artery).toBeLessThan(sample.artery);
    network.segments.push({ ...network.segments[0]! });
    expect(sampleAtlasVessels([5, 0, 0], [0, 0, 1], network)).toEqual(sample);
    const color = applyAtlasVesselColor([0.4, 0.2, 0.12], sample);
    expect(color.every(v => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
    network.settings.visibility = 0;
    expect(sampleAtlasVessels([5, 0, 0], [0, 0, 1], network).heightMm).toBe(0);
  });
  it.each([40,64])("retains every overlapping candidate with grid resolution %i", (resolution) => {
    const network = lineNetwork(); network.segments = Array.from({ length: 300 }, () => structuredClone(network.segments[0]!));
    const grid = createAtlasVesselGrid(network,resolution);
    expect(grid.maxCellSegments).toBe(300);
    const cell = new THREE.Vector3(5, 0, 0).sub(grid.origin).divideScalar(grid.cellSize).floor();
    const index = cell.x + grid.dimensions.x * (cell.y + grid.dimensions.y * cell.z);
    expect(grid.headers[index * 4 + 1]).toBe(300);
    expect(Array.from(grid.candidates.slice(grid.headers[index * 4]!, grid.headers[index * 4]! + 300))).toEqual(Array.from({ length: 300 }, (_, i) => i));
  });
  it("installs rest-space shading, never changes geometry, and updates visibility without compiling", () => {
    const geometry = new THREE.SphereGeometry(75, 12, 8), material = new THREE.MeshPhysicalMaterial();
    const positions = Array.from(geometry.getAttribute("position").array), network = lineNetwork();
    const handle = installAtlasVessels(geometry, material, network);
    const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader, uniforms: {} } as Parameters<typeof material.onBeforeCompile>[0];
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(Array.from(geometry.getAttribute("position").array)).toEqual(positions);
    expect(shader.vertexShader).toContain("vAtlasRestPosition = atlasRestPosition");
    expect(shader.fragmentShader).toContain("gl_FrontFacing ? 1.0 : -1.0");
    expect(shader.fragmentShader).toContain("i < int(header.y)");
    expect(material.customProgramCacheKey()).toContain(ATLAS_VESSEL_VERSION);
    handle.setVisibility(0.3);
    expect(shader.uniforms.uVesselVisibility!.value).toBe(0.3);
    handle.dispose(); material.dispose(); geometry.dispose();
  });
});
