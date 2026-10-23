import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { AtlasGeneration } from "../../atlas";
import { adaptLiverAnatomy } from "./anatomy";
import { LIVER_CUT_LIMITS, previewLiverCut } from "./cutPreview";
import { prepareLiverCut } from "./wounds";
import type { LiverAnatomy, LiverSurface, LiverSurfacePick, LiverWound } from "./types";

/** Flat 20 mm capsule with one 0.2 mm vessel whose axis lies `vesselDepthM` below it. */
function plane(vesselDepthM = .001, lateralM = 0): LiverAnatomy {
  const surface: LiverSurface = { positionsM: new Float64Array([-.01, 0, -.01, .01, 0, -.01, .01, 0, .01, -.01, 0, .01]), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]) };
  return { surface, organ: { id: "liver", name: "test", kind: "organ", color: "#fff", positions: Array.from(surface.positionsM, p => p * 1000), indices: Array.from(surface.indices) },
    network: { segments: [] } as unknown as LiverAnatomy["network"], sourceTriangleIndices: new Uint32Array([0, 1]), sourceVertexIndices: new Uint32Array([0, 1, 2, 3]),
    vessels: [{ id: "vessel", aM: [-.005, -vesselDepthM, lateralM], bM: [.005, -vesselDepthM, lateralM], normal: [0, 1, 0], radiusAM: .0002, radiusBM: .0002, depthM: vesselDepthM, aTriangle: 0, bTriangle: 1 }],
    targets: [], provenance: { templateId: "fixture", label: "fixture", source: "fixture", license: "fixture", vascularModel: "procedural-surface-design-not-patient-vasculature", detail: "analytical plane" } } as unknown as LiverAnatomy;
}
const centre: LiverSurfacePick = { triangle: 0, barycentric: [.5, .5, 0], positionM: [0, 0, 0], normal: [0, 1, 0] };

describe("hover cut preview", () => {
  it("reports a vessel hit with the same vessel and aperture as the committed cut", () => {
    const anatomy = plane(), preview = previewLiverCut(anatomy, [], centre, .001, .0015);
    const commit = prepareLiverCut(anatomy, [], { pick: centre, radiusM: .001, depthM: .0015, timeSeconds: 0 });
    expect(preview.status).toBe("vessel"); expect(preview.vesselId).toBe(commit.wound!.vesselId);
    expect(preview.apertureRadiusM).toBeCloseTo(commit.wound!.apertureRadiusM, 14);
  });
  it("finds the analytic minimum depth (vessel top at 0.8 mm) and a slider step that reaches it", () => {
    const preview = previewLiverCut(plane(), [], centre, .001, .0005);
    expect(preview.status).toBe("deeper");
    expect(preview.minimumDepthM!).toBeCloseTo(.0008, 9);
    expect(preview.suggestedDepthM).toBeCloseTo(.001, 12);
    expect(previewLiverCut(plane(), [], centre, .001, preview.suggestedDepthM!).status).toBe("vessel");
    expect(prepareLiverCut(plane(), [], { pick: centre, radiusM: .001, depthM: preview.suggestedDepthM!, timeSeconds: 0 }).outcome).toBe("vessel-hit");
  });
  it("reports tissue only, with the lateral offset to the nearest vessel wall, when no depth can reach it", () => {
    const preview = previewLiverCut(plane(.001, .006), [], centre, .001, .002);
    expect(preview.status).toBe("tissue"); expect(preview.vesselId).toBeNull();
    // 6 mm axis offset − 0.2 mm vessel radius − 1 mm punch radius.
    expect(preview.nearestVesselOffsetM!).toBeCloseTo(.0048, 12);
    expect(prepareLiverCut(plane(.001, .006), [], { pick: centre, radiusM: .001, depthM: .002, timeSeconds: 0 }).outcome).toBe("tissue-only");
  });
  it("blocks overlapping sites and the fourth incision before the commit is attempted", () => {
    const wound = (x: number, i: number): LiverWound => ({ pick: { ...centre, positionM: [x, 0, 0] }, radiusM: .001, depthM: .001, timeSeconds: 0, id: `w${i}`, vesselId: null, apertureRadiusM: 0 });
    expect(previewLiverCut(plane(), [wound(.0015, 1)], centre, .001, .001)).toMatchObject({ status: "blocked", reason: expect.stringMatching(/Overlaps/) });
    expect(previewLiverCut(plane(), [wound(.008, 1), wound(-.008, 2), wound(.004, 3)].map(w => ({ ...w, pick: { ...w.pick, positionM: [w.pick.positionM[0], 0, .008] as [number, number, number] } })), centre, .001, .001).status).toBe("blocked");
  });
});

describe("hover cut preview on the HRA reference liver", () => {
  const anatomy = adaptLiverAnatomy(JSON.parse(gunzipSync(readFileSync(new URL("../../../../../public-copy/static/api/atlas/specimens/hra-liver-female.json.gz", import.meta.url))).toString()) as AtlasGeneration);
  it("agrees with the committed outcome at every authored target and suggested depth", () => {
    let compared = 0, hits = 0;
    for (const target of anatomy.targets) for (const depthM of [LIVER_CUT_LIMITS.minDepthM, .001, LIVER_CUT_LIMITS.maxDepthM]) {
      const preview = previewLiverCut(anatomy, [], target.pick, .00125, depthM);
      const commit = prepareLiverCut(anatomy, [], { pick: target.pick, radiusM: .00125, depthM, timeSeconds: 0 });
      if (!commit.accepted) continue; // Geometric rejections are commit-only by design.
      compared++; if (commit.outcome === "vessel-hit") hits++;
      expect(preview.status === "vessel", `${target.id} at ${depthM}`).toBe(commit.outcome === "vessel-hit");
      if (preview.status === "vessel") expect(preview.vesselId).toBe(commit.wound!.vesselId);
      if (preview.status === "deeper") {
        const deeper = prepareLiverCut(anatomy, [], { pick: target.pick, radiusM: .00125, depthM: preview.suggestedDepthM!, timeSeconds: 0 });
        if (deeper.accepted) expect(deeper.outcome).toBe("vessel-hit");
      }
    }
    expect(compared).toBeGreaterThanOrEqual(anatomy.targets.length); expect(hits).toBeGreaterThan(0); expect(hits).toBeLessThan(compared);
  });
  it("is cheap enough to evaluate on every hover change", () => {
    const start = performance.now();
    for (let i = 0; i < 50; i++) previewLiverCut(anatomy, [], anatomy.targets[i % anatomy.targets.length]!.pick, .00125, LIVER_CUT_LIMITS.minDepthM);
    expect((performance.now() - start) / 50).toBeLessThan(8);
  });
});
