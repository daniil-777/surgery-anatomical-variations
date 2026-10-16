import { describe, expect, it } from "vitest";
import * as THREE from "three";
import manifest from "../public/anatomy-scene/manifest.json";
import { referenceOklab, REFERENCE_ORGAN_IDS } from "./referenceColor";
import { makeWholeSceneTissueMaterial, wholeSceneBaselineColor } from "./wholeSceneMaterials";
import { BASELINE_VARIATION } from "./wholeSceneModel";
import { DEFAULT_LIBRARY_COLOR_OPTIONS, planWholeBodyColor, type WholeBodyObservation, type WholeBodyPart } from "./wholeBodyColor";

type RGB = [number, number, number];
const parts = manifest.organs as WholeBodyPart[];
const hash = (n: number) => n.toString(16).padStart(64, "0");
const base = (id: string) => wholeSceneBaselineColor(parts.find(part => part.id === id)!);
function observation(id: string, target = "liver", rgb: RGB = [.65, .3, .25], source = 1, mask = source): WholeBodyObservation {
  const organ = REFERENCE_ORGAN_IDS[target]!;
  return { id, source_id: `photo-${source}`, organ, targets: [target], reviewed: true, surface: "outer", analysis: {
    version: "reference-analysis-1", organ, source_sha256: hash(source), mask_sha256: hash(mask),
    reference_color: { version: "reference-color-1", organ, source_sha256: hash(source), mask_sha256: hash(mask), observed_srgb: rgb, strength: .65, mode: "chroma" },
    palette_srgb: [rgb], quality: { selected_pixels: 4096, accepted_pixels: 4096, accepted_fraction: 1, oklab_spread_10_90: [.02, .005, .005] }, warnings: [],
  } };
}
const closeRgb = (actual: RGB, expected: RGB, tolerance = 2e-6) => actual.forEach((channel, i) => expect(Math.abs(channel - expected[i]!)).toBeLessThan(tolerance));
const chromaDistance = (a: RGB, b: RGB) => { const x = referenceOklab(a), y = referenceOklab(b); return Math.hypot(x[1] - y[1], x[2] - y[2]); };

describe("default library colour visibility", () => {
  // Actual pooled liver colour from the bundled reference-library analysis.
  const libraryLiver: RGB = [.7316196461408377, .4799049395549179, .44236506137627896];

  it("transfers measured liver brightness while explicit tint mode preserves authored lightness", () => {
    const row = observation("library-liver", "liver", libraryLiver);
    const defaultPlan = planWholeBodyColor(parts, [row], DEFAULT_LIBRARY_COLOR_OPTIONS);
    const tint = planWholeBodyColor(parts, [row], { ...DEFAULT_LIBRARY_COLOR_OPTIONS, mode: "chroma" });
    const previousDefault = planWholeBodyColor(parts, [row], { strength: .65, mode: "chroma", related: true, harmonize: true });
    const beforeL = referenceOklab(base("liver"))[0];
    expect(referenceOklab(defaultPlan.assignments.liver!.color_srgb)[0] - beforeL).toBeGreaterThan(.08);
    expect(referenceOklab(tint.assignments.liver!.color_srgb)[0]).toBeCloseTo(beforeL, 6);
    expect(referenceOklab(previousDefault.assignments.liver!.color_srgb)[0]).toBeCloseTo(beforeL, 6);
    expect(defaultPlan.assignments.liver!.basis).toBe("direct");
  });

  it("renders the planned liver base colour without changing its optical finish or tissue fields", () => {
    const part = Object.freeze({ ...parts.find(part => part.id === "liver")! });
    const plan = planWholeBodyColor(parts, [observation("library-liver", "liver", libraryLiver)], DEFAULT_LIBRARY_COLOR_OPTIONS);
    // Material construction does not take geometry or simulation state. GPU
    // framebuffer/geometry preservation is covered by the viewport integration tests.
    const volume = new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1), breath = { value: 0 };
    const before = makeWholeSceneTissueMaterial(part, BASELINE_VARIATION, breath, volume);
    const after = makeWholeSceneTissueMaterial(part, BASELINE_VARIATION, breath, volume, { reference: plan.referenceColors.liver });
    try {
      const displayed = after.material.color.clone().convertLinearToSRGB();
      // Three uses an approximate 0.41666 sRGB exponent; compare below one
      // hundredth of an 8-bit display step and also require exact display RGB.
      closeRgb([displayed.r, displayed.g, displayed.b], plan.assignments.liver!.color_srgb, 1e-5);
      const expectedColor = new THREE.Color().setRGB(...plan.assignments.liver!.color_srgb, THREE.SRGBColorSpace);
      expect(after.material.color.getHexString()).toBe(expectedColor.getHexString());
      expect(after.material.color.equals(before.material.color)).toBe(false);
      for (const key of ["roughness", "metalness", "ior", "specularIntensity", "clearcoat", "clearcoatRoughness", "envMapIntensity", "opacity", "transparent", "depthWrite", "side"] as const) {
        expect(after.material[key], key).toBe(before.material[key]);
      }
      const { color: _beforeColor, ...beforeFields } = JSON.parse(before.signature);
      const { color: _afterColor, reference_color: _reference, ...afterFields } = JSON.parse(after.signature);
      expect(afterFields).toEqual(beforeFields);
    } finally { before.material.dispose(); after.material.dispose(); volume.dispose(); }
  });

  it("returns exact authored colours at zero strength and leaves rendered colour unchanged", () => {
    const plan = planWholeBodyColor(parts, [observation("library-liver", "liver", libraryLiver)], { ...DEFAULT_LIBRARY_COLOR_OPTIONS, strength: 0 });
    for (const [id, assignment] of Object.entries(plan.assignments)) expect(assignment.color_srgb).toEqual(base(id));
    const part = parts.find(part => part.id === "liver")!, volume = new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1), breath = { value: 0 };
    const before = makeWholeSceneTissueMaterial(part, BASELINE_VARIATION, breath, volume);
    const after = makeWholeSceneTissueMaterial(part, BASELINE_VARIATION, breath, volume, { reference: plan.referenceColors.liver });
    try {
      // Linear↔sRGB round trips have floating-point error but must not change the display RGB.
      expect(after.material.color.getHexString()).toBe(before.material.color.getHexString());
      closeRgb([after.material.color.r, after.material.color.g, after.material.color.b], [before.material.color.r, before.material.color.g, before.material.color.b], 1e-5);
    } finally { before.material.dispose(); after.material.dispose(); volume.dispose(); }
  });

  it("keeps unseen organs lightness-preserving and bounded with the stronger photo default", () => {
    const plan = planWholeBodyColor(parts, [observation("red-colon", "colon", [.98, .01, .01])], DEFAULT_LIBRARY_COLOR_OPTIONS);
    expect(plan.assignments["small-intestine"]!.basis).toBe("related");
    expect(plan.assignments.heart!.basis).toBe("harmonized");
    for (const [id, assignment] of Object.entries(plan.assignments)) {
      if (assignment.basis !== "related" && assignment.basis !== "harmonized") continue;
      const cap = assignment.basis === "related" ? .035 : .02;
      expect(chromaDistance(assignment.color_srgb, base(id)), id).toBeLessThanOrEqual(cap * DEFAULT_LIBRARY_COLOR_OPTIONS.strength + 1e-6);
      expect(referenceOklab(assignment.color_srgb)[0], id).toBeCloseTo(referenceOklab(base(id))[0], 6);
      expect(plan.referenceColors[id]!.mode).toBe("chroma");
    }
    for (const part of parts.filter(part => part.category === "skeleton")) expect(plan.referenceColors[part.id]).toBeUndefined();
  });
});

describe("whole body reviewed colour planning", () => {
  it("accounts for every actual soft structure and excludes all three bones", () => {
    const plan = planWholeBodyColor(parts, []);
    expect(Object.keys(plan.assignments)).toHaveLength(36);
    expect(Object.keys(plan.referenceColors)).toHaveLength(0);
    for (const part of parts) {
      if (part.category === "skeleton") expect(plan.assignments[part.id]).toBeUndefined();
      else { expect(plan.assignments[part.id]!.basis).toBe("authored"); expect(plan.assignments[part.id]!.color_srgb).toEqual(base(part.id)); }
    }
  });
  it("supports an explicit direct observation for all 36 soft targets", () => {
    const rows = parts.filter(part => part.category !== "skeleton").map((part, i) => observation(`r${i}`, part.id, base(part.id), i + 1));
    const plan = planWholeBodyColor(parts, rows);
    expect(Object.keys(plan.referenceColors)).toHaveLength(36);
    expect(Object.values(plan.assignments).every(item => item.basis === "direct")).toBe(true);
  });
  it("ignores unreviewed rows and rejects a reviewed mismatched organ, skeleton, or fabricated target", () => {
    const row = observation("r"); row.targets = ["heart"];
    expect(() => planWholeBodyColor(parts, [row])).toThrow(/does not match/);
    row.reviewed = false; expect(planWholeBodyColor(parts, [row]).referenceColors).toEqual({});
    row.reviewed = true;
    for (const target of ["rib-cage", "__proto__", "imaginary-organ"]) { row.targets = [target]; expect(() => planWholeBodyColor(parts, [row])).toThrow(); }
  });
  it("pools distinct images robustly while retaining every source and quality in provenance", () => {
    const good: RGB = [.65, .3, .25];
    const rows = [observation("a", "liver", good, 1), observation("b", "liver", good, 2), observation("bad", "liver", [.05, .1, .95], 3)];
    const plan = planWholeBodyColor(parts, rows, { strength: 1, mode: "color" });
    closeRgb(plan.assignments.liver!.color_srgb, good);
    expect(plan.assignments.liver!.evidence).toHaveLength(3);
    expect(plan.assignments.liver!.evidence.reduce((sum, item) => sum + item.weight, 0)).toBeCloseTo(1, 10);
    expect(plan.assignments.liver!.evidence[0]!.quality.accepted_pixels).toBe(4096);
    expect(plan.assignments.liver!.warnings.join(" ")).toMatch(/disagree/);
    expect(planWholeBodyColor(parts, [...rows].reverse(), { strength: 1, mode: "color" })).toEqual(plan);
  });
  it("does not let many masks from one correlated photograph outvote independent photographs", () => {
    const good: RGB = [.65, .3, .25], bad: RGB = [.05, .1, .95];
    const rows = [observation("a", "liver", good, 1), observation("b", "liver", good, 2), ...Array.from({ length: 30 }, (_, i) => observation(`bad-${i}`, "liver", bad, 3, 100 + i))];
    const plan = planWholeBodyColor(parts, rows, { strength: 1, mode: "color" });
    closeRgb(plan.assignments.liver!.color_srgb, good);
    expect(plan.assignments.liver!.evidence.filter(item => item.source_sha256 === hash(3)).reduce((sum, item) => sum + item.weight, 0)).toBeCloseTo(1 / 3, 10);
  });
  it("caps correlated frames from one capture group across distinct image hashes", () => {
    const good: RGB = [.65, .3, .25], bad: RGB = [.05, .1, .95];
    const rows = [
      { ...observation("a", "liver", good, 1), capture_group: "surgery-a" },
      { ...observation("b", "liver", good, 2), capture_group: "surgery-b" },
      ...Array.from({ length: 20 }, (_, i) => ({ ...observation(`correlated-${i}`, "liver", bad, 10 + i), capture_group: "surgery-c", identity_source: "Reviewed dataset label", source_url: "https://example.org/dataset" })),
    ];
    const plan = planWholeBodyColor(parts, rows, { strength: 1, mode: "color", harmonize: true });
    closeRgb(plan.assignments.liver!.color_srgb, good);
    for (const id of ["liver", "heart"]) {
      const grouped = plan.assignments[id]!.evidence.filter(item => item.capture_group === "surgery-c");
      expect(grouped).toHaveLength(20);
      expect(grouped.reduce((sum, item) => sum + item.weight, 0)).toBeCloseTo(1 / 3, 10);
      expect(grouped.every(item => item.identity_source === "Reviewed dataset label" && item.source_url === "https://example.org/dataset")).toBe(true);
    }
    const oneFramePerGroup = planWholeBodyColor(parts, rows.slice(0, 3), { strength: 1, mode: "color", harmonize: true });
    expect(plan.referenceColors).toEqual(oneFramePerGroup.referenceColors);
    expect(planWholeBodyColor(parts, [...rows].reverse(), { strength: 1, mode: "color", harmonize: true })).toEqual(plan);
  });
  it("preserves image-based upload behavior when no capture groups are supplied", () => {
    const rows = [observation("a", "liver", [.65, .3, .25], 1), observation("b", "liver", [.65, .3, .25], 2), observation("c", "liver", [.05, .1, .95], 3)];
    const ungrouped = planWholeBodyColor(parts, rows, { harmonize: true });
    const separateGroups = planWholeBodyColor(parts, rows.map(row => ({ ...row, capture_group: `independent-${row.id}` })), { harmonize: true });
    expect(ungrouped.referenceColors).toEqual(separateGroups.referenceColors);
    expect(ungrouped.assignments.liver!.evidence.every(item => !Object.hasOwn(item, "capture_group"))).toBe(true);
    expect(ungrouped.assignments.liver!.evidence.map(item => item.weight)).toEqual(separateGroups.assignments.liver!.evidence.map(item => item.weight));
  });
  it("preserves within-capture disagreement and rejects contradictory groups for one image", () => {
    const first = { ...observation("a", "liver", [.65, .3, .25], 1), capture_group: "same-capture" };
    const second = { ...observation("b", "liver", [.05, .1, .95], 2), capture_group: "same-capture" };
    const plan = planWholeBodyColor(parts, [first, second]);
    expect(plan.assignments.liver!.warnings.join(" ")).toMatch(/disagree/);
    const anotherMask = observation("c", "liver", [.65, .3, .25], 1, 99);
    const inherited = planWholeBodyColor(parts, [first, anotherMask]);
    expect(inherited.assignments.liver!.evidence.every(item => item.capture_group === "same-capture")).toBe(true);
    expect(() => planWholeBodyColor(parts, [first, { ...anotherMask, capture_group: "conflicting-capture" }])).toThrow(/conflicting capture groups/);
  });
  it("rejects malformed optional provenance without changing legacy observations", () => {
    for (const extra of [{ capture_group: "" }, { capture_group: "x".repeat(257) }, { identity_source: "x".repeat(1025) }, { source_url: "javascript:alert(1)" }, { source_url: "//outside.example/image" }]) {
      expect(() => planWholeBodyColor(parts, [{ ...observation("a"), ...extra }])).toThrow(/Invalid reference/);
    }
    const row = { ...observation("a"), identity_source: "User-assigned tissue identity", source_url: "/body-reference/provenance.json" };
    const plan = planWholeBodyColor(parts, [row]);
    expect(plan.assignments.liver!.evidence[0]!.identity_source).toBe(row.identity_source);
    expect(plan.assignments.liver!.evidence[0]!.source_url).toBe(row.source_url);
  });
  it("counts identical content once even when filenames differ and rejects conflicting duplicates", () => {
    const first = observation("a"), copy = structuredClone(first); copy.id = "b"; copy.source_id = "renamed-image";
    const plan = planWholeBodyColor(parts, [first, copy]);
    expect(plan.assignments.liver!.evidence).toHaveLength(1); expect(plan.warnings.join(" ")).toMatch(/Duplicate/);
    copy.analysis.reference_color.observed_srgb = [.1, .2, .3];
    expect(() => planWholeBodyColor(parts, [first, copy])).toThrow(/Conflicting/);
  });
  it("discounts low acceptance and broad colour spread instead of treating pixels as independent confidence", () => {
    const good = observation("good"), low = observation("low", "liver", [.1, .1, .9], 2);
    low.analysis.quality = { selected_pixels: 4096, accepted_pixels: 64, accepted_fraction: 64 / 4096, oklab_spread_10_90: [.3, .2, .2] };
    const plan = planWholeBodyColor(parts, [good, low], { strength: 1, mode: "color" });
    closeRgb(plan.assignments.liver!.color_srgb, good.analysis.reference_color.observed_srgb);
    expect(plan.assignments.liver!.evidence.find(item => item.observation_id === "low")!.weight).toBeLessThan(.01);
  });
  it("preserves exact baseline at strength zero and direct lightness in chroma mode", () => {
    const row = observation("r");
    const zero = planWholeBodyColor(parts, [row], { strength: 0, related: true, harmonize: true });
    for (const [id, assignment] of Object.entries(zero.assignments)) expect(assignment.color_srgb).toEqual(base(id));
    const chroma = planWholeBodyColor(parts, [row], { strength: 1 });
    expect(referenceOklab(chroma.assignments.liver!.color_srgb)[0]).toBeCloseTo(referenceOklab(base("liver"))[0], 6);
  });
  it("borrows a bounded outer-surface colour delta only within explicit families", () => {
    const row = observation("r", "colon", [.85, .15, .15]);
    const plan = planWholeBodyColor(parts, [row], { related: true, strength: 1, mode: "color" });
    expect(plan.assignments["small-intestine"]!.basis).toBe("related"); expect(plan.assignments.stomach!.basis).toBe("authored");
    const assigned = plan.assignments["small-intestine"]!.color_srgb;
    expect(chromaDistance(assigned, base("small-intestine"))).toBeLessThanOrEqual(.035001);
    expect(referenceOklab(assigned)[0]).toBeCloseTo(referenceOklab(base("small-intestine"))[0], 6);
    expect(chromaDistance(assigned, row.analysis.reference_color.observed_srgb)).toBeGreaterThan(.05);
    expect(plan.referenceColors["small-intestine"]!.mode).toBe("chroma");
  });
  it("keeps inferred changes to every missing soft structure bounded under a blood-red source", () => {
    const row = observation("r", "liver", [.98, .01, .01]);
    const plan = planWholeBodyColor(parts, [row], { harmonize: true, strength: 1 });
    expect(Object.keys(plan.referenceColors)).toHaveLength(36);
    for (const [id, item] of Object.entries(plan.assignments)) {
      if (id === "liver") continue;
      expect(item.basis).toBe("harmonized"); expect(chromaDistance(item.color_srgb, base(id))).toBeLessThanOrEqual(.020001);
      expect(referenceOklab(item.color_srgb)[0]).toBeCloseTo(referenceOklab(base(id))[0], 6);
      expect(item.evidence[0]!.observed_srgb).toEqual(row.analysis.reference_color.observed_srgb);
    }
    expect(chromaDistance(plan.assignments.gallbladder!.color_srgb, plan.assignments.heart!.color_srgb)).toBeGreaterThan(.08);
  });
  it.each(["unknown", "mucosa", "cut"] as const)("does not propagate %s surfaces as exterior evidence", surface => {
    const row = observation("r", "colon"); row.surface = surface;
    const plan = planWholeBodyColor(parts, [row], { related: true, harmonize: true });
    expect(plan.assignments.colon!.basis).toBe("direct"); expect(plan.assignments["small-intestine"]!.basis).toBe("authored");
    expect(plan.assignments.colon!.warnings.join(" ")).toMatch(/surface/);
  });
  it("rejects nonfinite controls, forged hash relationships, contradictory acceptance and malformed spread", () => {
    expect(() => planWholeBodyColor(parts, [], { strength: NaN })).toThrow();
    const hashRow = observation("hash"); hashRow.analysis.source_sha256 = hash(88); expect(() => planWholeBodyColor(parts, [hashRow])).toThrow(/hash/);
    const q = observation("q"); q.analysis.quality.accepted_fraction = .1; expect(() => planWholeBodyColor(parts, [q])).toThrow(/quality/);
    const spread = observation("spread"); spread.analysis.quality.oklab_spread_10_90 = [0, NaN, .1]; expect(() => planWholeBodyColor(parts, [spread])).toThrow(/quality/);
  });
  it("does not mutate input measurements and keeps planning JSON serializable", () => {
    const rows = [observation("r")], before = structuredClone(rows);
    const plan = planWholeBodyColor(parts, rows, { harmonize: true });
    expect(rows).toEqual(before); expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
    plan.assignments.liver!.evidence[0]!.quality.accepted_pixels = 1;
    expect(rows).toEqual(before);
  });
});
