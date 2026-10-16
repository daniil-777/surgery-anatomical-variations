import { validateReferenceColor, type ReferenceColor } from "./atlasMaterial";
import { referenceBaseColor, referenceOklab, REFERENCE_ORGAN_IDS } from "./referenceColor";
import { wholeSceneBaselineColor } from "./wholeSceneMaterials";
import type { WholeSceneCategory } from "./wholeSceneModel";

type RGB = [number, number, number];
export type WholeBodySurface = "outer" | "mucosa" | "cut" | "unknown";
export interface WholeBodyAnalysis {
  version: "reference-analysis-1";
  organ: string;
  source_sha256: string;
  mask_sha256: string;
  reference_color: ReferenceColor;
  palette_srgb: RGB[];
  quality: {
    selected_pixels: number; accepted_pixels: number; accepted_fraction: number;
    oklab_spread_10_90?: RGB;
  };
  warnings: string[];
}
export interface WholeBodyObservation {
  id: string; source_id: string; organ: string; targets: string[];
  analysis: WholeBodyAnalysis; reviewed: boolean; surface?: WholeBodySurface;
  capture_group?: string; identity_source?: string; source_url?: string;
}
export interface WholeBodyColorOptions {
  strength?: number; mode?: "chroma" | "color"; related?: boolean; harmonize?: boolean;
}
export interface WholeBodyEvidence {
  observation_id: string; target_id: string; source_id: string; source_sha256: string; mask_sha256: string;
  surface: WholeBodySurface; observed_srgb: RGB; weight: number;
  quality: WholeBodyAnalysis["quality"]; palette_srgb: RGB[];
  capture_group?: string; identity_source?: string; source_url?: string;
}
export interface WholeBodyColorAssignment {
  target_id: string; organ: string;
  basis: "direct" | "related" | "harmonized" | "authored";
  color_srgb: RGB; source_target_ids: string[]; evidence: WholeBodyEvidence[];
  disagreement_oklab: number; warnings: string[];
}
export interface WholeBodyColorPlan {
  version: "whole-body-color-1";
  /** Renderer compatibility carriers. Their hashes identify a representative input,
   * not the pooled colour. Keep assignments with these carriers on export. */
  referenceColors: Record<string, ReferenceColor>;
  assignments: Record<string, WholeBodyColorAssignment>;
  warnings: string[];
  settings: Required<WholeBodyColorOptions>;
}
export interface WholeBodyPart { id: string; category: WholeSceneCategory; color: string }

/** Photo brightness is included only for directly observed tissue. Inferred
 * structures keep the planner's existing conservative chroma-only bounds. */
export const DEFAULT_LIBRARY_COLOR_OPTIONS: Readonly<Required<WholeBodyColorOptions>> = Object.freeze({
  strength: .85, mode: "color", related: true, harmonize: true,
});

/** Deliberately narrow, authored appearance relationships, not tissue equivalence. */
export const WHOLE_BODY_COLOR_FAMILIES: readonly (readonly string[])[] = [
  ["left-kidney", "right-kidney"], ["left-lung", "right-lung"],
  ["small-intestine", "duodenum", "colon"], ["left-ureter", "right-ureter"],
  ["cystic-duct", "hepatic-duct"], ["trachea", "bronchi"],
  ["aorta", "hepatic-artery", "superior-mesenteric-artery", "inferior-mesenteric-artery",
    "right-renal-artery", "left-renal-artery", "splenic-artery", "celiac-trunk"],
  ["vena-cava", "portal-vein", "right-renal-vein", "left-renal-vein"],
];
const familyFor = (id: string) => WHOLE_BODY_COLOR_FAMILIES.find(group => group.includes(id));
const finiteRgb = (value: unknown): value is RGB => Array.isArray(value) && value.length === 3 && value.every(x => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1);
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const distance = (a: RGB, b: RGB) => Math.hypot(...a.map((x, i) => x - b[i]!));
const subtract = (a: RGB, b: RGB) => a.map((x, i) => x - b[i]!) as RGB;

// Same public-domain Oklab inverse as referenceColor; chroma reduction preserves L.
function gamutSrgb(lab: RGB): RGB {
  const linear = ([L, a, b]: RGB): RGB => {
    const l = (L + .3963377774*a + .2158037573*b) ** 3;
    const m = (L - .1055613458*a - .0638541728*b) ** 3;
    const s = (L - .0894841775*a - 1.2914855480*b) ** 3;
    return [4.0767416621*l - 3.3077115913*m + .2309699292*s, -1.2684380046*l + 2.6097574011*m - .3413193965*s, -.0041960863*l - .7034186147*m + 1.7076147010*s];
  };
  const inGamut = (rgb: RGB) => rgb.every(x => x >= -1e-9 && x <= 1 + 1e-9);
  let low = 0, high = 1;
  if (!inGamut(linear(lab))) {
    for (let i = 0; i < 24; i++) {
      const scale = (low + high) / 2;
      if (inGamut(linear([lab[0], lab[1] * scale, lab[2] * scale]))) low = scale; else high = scale;
    }
    lab = [lab[0], lab[1] * low, lab[2] * low];
  }
  return linear(lab).map(value => { const x = clamp(value); return x <= .0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - .055; }) as RGB;
}
interface Weighted { lab: RGB; weight: number }
/** Componentwise weighted median, with the midpoint of a balanced interval.
 * Deterministic under input permutations; a minority outlier has bounded influence. */
function median(values: Weighted[]): RGB {
  if (!values.length) throw new Error("No colour evidence to pool");
  const half = values.reduce((sum, item) => sum + item.weight, 0) / 2;
  return [0, 1, 2].map(channel => {
    const sorted = [...values].sort((a, b) => a.lab[channel]! - b.lab[channel]!);
    let cumulative = 0;
    for (let i = 0; i < sorted.length; i++) {
      cumulative += sorted[i]!.weight;
      if (Math.abs(cumulative - half) < 1e-12 && i + 1 < sorted.length) return (sorted[i]!.lab[channel]! + sorted[i + 1]!.lab[channel]!) / 2;
      if (cumulative >= half) return sorted[i]!.lab[channel]!;
    }
    return sorted.at(-1)!.lab[channel]!;
  }) as RGB;
}
interface Pooled { lab: RGB; evidence: WholeBodyEvidence[]; disagreement: number }
/** Pool regions within images, images within declared capture groups, then
 * across groups. Each image/group gets at most its strongest child's weight.
 * These are dependency heuristics, not independent-patient confidence estimates. */
function pool(evidence: WholeBodyEvidence[], labs: RGB[] = evidence.map(item => referenceOklab(item.observed_srgb))): Pooled {
  const byImage = new Map<string, { item: WholeBodyEvidence; lab: RGB; weight: number }[]>();
  evidence.forEach((item, index) => byImage.set(item.source_sha256, [...(byImage.get(item.source_sha256) ?? []), { item, lab: labs[index]!, weight: item.weight }]));
  const images = [...byImage.values()].map(items => ({
    lab: median(items),
    weight: Math.max(...items.map(item => item.weight)), items,
  }));
  const byCapture = new Map<string, typeof images>();
  for (const source of images) {
    const first = source.items[0]!.item;
    const key = first.capture_group ? `capture:${first.capture_group}` : `image:${first.source_sha256}`;
    byCapture.set(key, [...(byCapture.get(key) ?? []), source]);
  }
  const captures = [...byCapture.values()].map(group => ({ images: group, lab: median(group), weight: Math.max(...group.map(source => source.weight)) }));
  const lab = median(captures), total = captures.reduce((sum, capture) => sum + capture.weight, 0);
  let variance = 0;
  const normalized = captures.flatMap(capture => {
    const captureTotal = capture.images.reduce((sum, source) => sum + source.weight, 0);
    return capture.images.flatMap(source => {
      const imageWeight = capture.weight / total * source.weight / captureTotal;
      variance += imageWeight * distance(source.lab, lab) ** 2;
      const within = source.items.reduce((sum, item) => sum + item.weight, 0);
      return source.items.map(item => ({ ...item.item, weight: imageWeight * item.weight / within }));
    });
  }).sort((a, b) => a.source_sha256.localeCompare(b.source_sha256) || a.mask_sha256.localeCompare(b.mask_sha256) || a.observation_id.localeCompare(b.observation_id));
  return { lab, evidence: normalized, disagreement: Math.sqrt(variance) };
}
function validateObservation(row: WholeBodyObservation, parts: Map<string, WholeBodyPart>): void {
  const analysis = row.analysis;
  if (!row.id?.trim() || !row.source_id?.trim() || !row.organ?.trim() || !Array.isArray(row.targets) || !row.targets.length || new Set(row.targets).size !== row.targets.length)
    throw new Error("A reviewed region needs a unique identity and explicit targets");
  if (!analysis || analysis.version !== "reference-analysis-1" || analysis.organ !== row.organ) throw new Error("Mismatched reference analysis");
  validateReferenceColor(analysis.reference_color, row.organ);
  if (analysis.source_sha256 !== analysis.reference_color.source_sha256 || analysis.mask_sha256 !== analysis.reference_color.mask_sha256) throw new Error("Mismatched reference evidence hashes");
  const q = analysis.quality;
  if (!q || !Number.isInteger(q.selected_pixels) || !Number.isInteger(q.accepted_pixels) || q.accepted_pixels < 1 || q.accepted_pixels > q.selected_pixels ||
      !Number.isFinite(q.accepted_fraction) || q.accepted_fraction <= 0 || q.accepted_fraction > 1 || Math.abs(q.accepted_fraction - q.accepted_pixels / q.selected_pixels) > 1e-6 ||
      (q.oklab_spread_10_90 !== undefined && !finiteRgb(q.oklab_spread_10_90)) ||
      !Array.isArray(analysis.palette_srgb) || !analysis.palette_srgb.length || !analysis.palette_srgb.every(finiteRgb) ||
      !Array.isArray(analysis.warnings) || !analysis.warnings.every(warning => typeof warning === "string")) throw new Error("Invalid reference colour quality data");
  if (row.surface !== undefined && !["outer", "mucosa", "cut", "unknown"].includes(row.surface)) throw new Error("Unknown reference surface");
  for (const [field, limit] of [["capture_group", 256], ["identity_source", 1024], ["source_url", 2048]] as const) {
    const value = row[field];
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > limit)) throw new Error(`Invalid reference ${field}`);
  }
  if (row.source_url !== undefined) {
    let url: URL;
    try { url = new URL(row.source_url, "https://local.invalid"); } catch { throw new Error("Invalid reference source_url"); }
    if ((!row.source_url.startsWith("/") && !/^https?:\/\//i.test(row.source_url)) || row.source_url.startsWith("//") || row.source_url.includes("\\") || !["http:", "https:"].includes(url.protocol)) throw new Error("Invalid reference source_url");
  }
  for (const target of row.targets) {
    if (!parts.has(target) || !Object.hasOwn(REFERENCE_ORGAN_IDS, target) || REFERENCE_ORGAN_IDS[target] !== row.organ) throw new Error(`Reference organ does not match target ${target}`);
  }
}
function qualityWeight(q: WholeBodyAnalysis["quality"]): number {
  const spread = q.oklab_spread_10_90;
  // Heuristic display weights, not calibrated probabilities or tissue confidence.
  return q.accepted_fraction * Math.sqrt(Math.min(q.accepted_pixels, 4096) / 4096) / (1 + (spread ? Math.hypot(spread[1], spread[2]) : 0) / .05);
}
function limitedShift(baseline: RGB, delta: RGB, maxChroma: number): RGB {
  const scale = Math.min(1, maxChroma / Math.max(1e-12, Math.hypot(delta[1], delta[2])));
  return gamutSrgb([baseline[0], baseline[1] + delta[1] * scale, baseline[2] + delta[2] * scale]);
}

/** Pure, synchronous planning only: no network, image pixels, geometry or physics.
 * Related/global adjustments are explicitly authored inference and always preserve L. */
export function planWholeBodyColor(parts: readonly WholeBodyPart[], observations: readonly WholeBodyObservation[], options: WholeBodyColorOptions = {}): WholeBodyColorPlan {
  const settings: Required<WholeBodyColorOptions> = { strength: options.strength ?? .65, mode: options.mode ?? "chroma", related: options.related ?? false, harmonize: options.harmonize ?? false };
  if (!Number.isFinite(settings.strength) || settings.strength < 0 || settings.strength > 1 || !["chroma", "color"].includes(settings.mode) || typeof settings.related !== "boolean" || typeof settings.harmonize !== "boolean") throw new Error("Invalid whole-body colour settings");
  const soft = new Map<string, WholeBodyPart>();
  for (const part of parts) {
    if (part.category === "skeleton") continue;
    if (!Object.hasOwn(REFERENCE_ORGAN_IDS, part.id) || soft.has(part.id)) throw new Error(`Unsupported or duplicate tissue target ${part.id}`);
    soft.set(part.id, part);
  }
  const plan: WholeBodyColorPlan = { version: "whole-body-color-1", referenceColors: {}, assignments: {}, warnings: [], settings };
  const targetEvidence = new Map<string, WholeBodyEvidence[]>(), targetWarnings = new Map<string, string[]>();
  const reviewed = observations.filter(row => row.reviewed), ids = new Set<string>(), imageGroups = new Map<string, string>();
  for (const row of reviewed) {
    validateObservation(row, soft);
    if (ids.has(row.id)) throw new Error("Duplicate reviewed observation ID");
    ids.add(row.id);
    if (row.capture_group !== undefined) {
      const group = imageGroups.get(row.analysis.source_sha256);
      if (group !== undefined && group !== row.capture_group) throw new Error("The same source image has conflicting capture groups");
      imageGroups.set(row.analysis.source_sha256, row.capture_group);
    }
  }
  for (const row of [...reviewed].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const target of row.targets) {
      const items = targetEvidence.get(target) ?? [];
      const duplicate = items.find(item => item.source_sha256 === row.analysis.source_sha256 && item.mask_sha256 === row.analysis.mask_sha256);
      if (duplicate) {
        if (duplicate.surface !== (row.surface ?? "unknown") || duplicate.observed_srgb.some((x, i) => x !== row.analysis.reference_color.observed_srgb[i])) throw new Error("Conflicting duplicate reference evidence");
        plan.warnings.push(`Duplicate region ${row.id} for ${target} was counted once.`); continue;
      }
      const captureGroup = imageGroups.get(row.analysis.source_sha256);
      items.push({ observation_id: row.id, target_id: target, source_id: row.source_id, source_sha256: row.analysis.source_sha256, mask_sha256: row.analysis.mask_sha256, surface: row.surface ?? "unknown", observed_srgb: [...row.analysis.reference_color.observed_srgb], weight: qualityWeight(row.analysis.quality), quality: structuredClone(row.analysis.quality), palette_srgb: row.analysis.palette_srgb.map(rgb => [...rgb]),
        ...(captureGroup !== undefined ? { capture_group: captureGroup } : {}),
        ...(row.identity_source !== undefined ? { identity_source: row.identity_source } : {}),
        ...(row.source_url !== undefined ? { source_url: row.source_url } : {}),
      });
      targetEvidence.set(target, items);
      targetWarnings.set(target, [...(targetWarnings.get(target) ?? []), ...row.analysis.warnings]);
    }
  }
  const direct = new Map<string, Pooled>();
  for (const [target, items] of targetEvidence) direct.set(target, pool(items));
  const commit = (part: WholeBodyPart, basis: WholeBodyColorAssignment["basis"], rgb: RGB, evidence: WholeBodyEvidence[], sources: string[], disagreement: number, warnings: string[]) => {
    const organ = REFERENCE_ORGAN_IDS[part.id]!, baseline = wholeSceneBaselineColor(part);
    let color: RGB = baseline;
    if (basis !== "authored") {
      const representative = evidence[0]!;
      const reference: ReferenceColor = { version: "reference-color-1", source_sha256: representative.source_sha256, mask_sha256: representative.mask_sha256, organ, observed_srgb: rgb, strength: settings.strength, mode: basis === "direct" ? settings.mode : "chroma" };
      plan.referenceColors[part.id] = reference;
      color = referenceBaseColor(baseline, reference);
    }
    plan.assignments[part.id] = { target_id: part.id, organ, basis, color_srgb: color, source_target_ids: sources, evidence, disagreement_oklab: disagreement, warnings: [...new Set(warnings)] };
  };
  for (const [id, part] of soft) {
    const value = direct.get(id);
    if (value) {
      const warnings = [...(targetWarnings.get(id) ?? [])];
      if (value.evidence.some(item => item.surface !== "outer")) warnings.push("Verify the reference surface matches the atlas exterior; mucosa and cut surfaces are different appearances.");
      if (value.disagreement > .06) warnings.push("Reference images disagree in observed colour; review lighting, surface and source selection.");
      commit(part, "direct", gamutSrgb(value.lab), value.evidence, [id], value.disagreement, warnings);
    }
  }
  // Residuals preserve each target's authored identity; never apply one organ's
  // absolute colour to every organ. Each source image has a capped contribution.
  for (const [id, part] of soft) {
    if (direct.has(id)) continue;
    const family = familyFor(id), relatedIds = settings.related && family ? [...direct.keys()].filter(key => family.includes(key) && direct.get(key)!.evidence.some(item => item.surface === "outer")) : [];
    const globalIds = settings.harmonize ? [...direct.keys()].filter(key => direct.get(key)!.evidence.some(item => item.surface === "outer")) : [];
    const sources = relatedIds.length ? relatedIds : globalIds;
    if (!sources.length) { commit(part, "authored", wholeSceneBaselineColor(part), [], [], 0, []); continue; }
    // Reuse original quality, not already normalized direct-pool weights; the
    // image/capture hierarchy must cap evidence once, not penalize groups twice.
    const evidence = sources.flatMap(source => direct.get(source)!.evidence.filter(item => item.surface === "outer").map(item => ({ ...item, weight: qualityWeight(item.quality) })));
    const residuals = evidence.map(item => {
      const baseline = referenceOklab(wholeSceneBaselineColor(soft.get(item.target_id)!));
      const delta = subtract(referenceOklab(item.observed_srgb), baseline);
      return [0, delta[1], delta[2]] as RGB;
    });
    const pooled = pool(evidence, residuals);
    const delta = pooled.lab;
    const basis = relatedIds.length ? "related" : "harmonized";
    commit(part, basis, limitedShift(referenceOklab(wholeSceneBaselineColor(part)), delta, basis === "related" ? .035 : .02), pooled.evidence, sources.sort(), pooled.disagreement,
      [basis === "related" ? "Inferred from related outer tissue; this target was not observed." : "Bounded palette harmonization; this target was not observed or colour calibrated."]);
  }
  if (!reviewed.length) plan.warnings.push("No reviewed observations: all tissues keep their authored appearance.");
  if (settings.related || settings.harmonize) plan.warnings.push("Inferred adjustments use reviewed outer surfaces only; missing or internal surface labels retain authored colours.");
  return plan;
}
