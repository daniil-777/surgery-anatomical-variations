// The imports package: analysis of 3D files people bring from Unity, Blender and other tools (DESIGN.md G4).
// analyzeFiles loads the analyser (three.js loaders, GLTFExporter, the thumbnail renderer) on first use, so pages
// that only list imports, sniff a drop or label sources stay small; everything else exported here is light.

import { cleanLabel } from "./bytes";
import { PlatformError, type ImportedObjectInput, type Uuid } from "../types";
import type { AnalyzeOptions, ImportAnalysis } from "./analyze";

export type { AnalyzeOptions, ImportAnalysis, ImportFileRole, ImportProgress, ImportStage } from "./analyze";
export { detectSource, matchApplication, SOURCE_APP_LABEL, type SourceDetection, type SourceSignals } from "./detect";
export { ImportChoiceError, ImportRejectedError, importRefusal } from "./errors";
export { fbxUnits, readFbxHeader, type FbxHeader } from "./fbx";
export { inspectGltf, parseGltfJson, readGlb, readGltf, type GltfFacts } from "./gltf";
export { IMPORT_LIMITS, formatBytes, importBudget, type ImportBudget } from "./limits";
export {
  FORMAT_LABEL,
  MODEL_MIME,
  SUPPORTED_SUMMARY,
  sniffBytes,
  sniffFile,
  sniffRefusal,
  type ModelFormat,
  type SidecarRole,
  type SniffResult,
  type UnsupportedFile,
} from "./sniff";
export { extractZip, listZip, zipFiles, type ZipEntryInfo } from "./zip";

/**
 * Everything an imported object needs from the selected files (see ImportAnalysis). Rejects with ImportRejectedError
 * (reason + advice; ImportChoiceError when several models could be the main file), PlatformError "aborted" when
 * `signal` fires, or PlatformError "network" when the analyser itself cannot be loaded.
 */
export async function analyzeFiles(files: File[], options: AnalyzeOptions): Promise<ImportAnalysis> {
  let analyzer: typeof import("./analyze");
  try {
    analyzer = await import("./analyze");
  } catch (error) {
    throw new PlatformError("network", "The importer could not be loaded. Check the connection and try again.", { detail: "importer-unavailable", cause: error });
  }
  return analyzer.analyzeFiles(files, options);
}

/** At most 20 distinct trimmed tags of 1–32 characters (the imported_objects.tags rule). */
export function importTags(tags: readonly string[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const cleaned = cleanLabel(tag, 32);
    if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
    seen.add(cleaned.toLowerCase());
    kept.push(cleaned);
    if (kept.length === 20) break;
  }
  return kept;
}

/** The row for ImportPort.create once the original (and preview, thumbnail) are uploaded as assets. */
export function importedObjectInput(
  analysis: ImportAnalysis,
  uploaded: { originalAssetId: Uuid; displayAssetId: Uuid | null; thumbnailAssetId: Uuid | null },
  tags?: string[],
): ImportedObjectInput {
  const input: ImportedObjectInput = {
    title: cleanLabel(analysis.title, 120) || "Imported model",
    format: analysis.format,
    originalAssetId: uploaded.originalAssetId,
    sourceApp: analysis.sourceApp,
    sourceDetail: analysis.sourceDetail === null ? null : cleanLabel(analysis.sourceDetail, 200) || null,
    detectedBy: analysis.detectedBy,
    displayAssetId: uploaded.displayAssetId,
    thumbnailAssetId: uploaded.thumbnailAssetId,
    stats: analysis.stats,
  };
  if (tags !== undefined) input.tags = importTags(tags);
  return input;
}
