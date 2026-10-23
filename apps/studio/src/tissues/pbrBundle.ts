import { materialAssets, materialFile } from "./assets";
import type { TissueManifest } from "./contracts";

export interface ImportedTissuePbr {
  manifest: TissueManifest;
  manifestSource: string;
  files: ReadonlyMap<string, Blob>;
  digest: string;
}
const MAX_BYTES = 32 * 1024 * 1024;
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, "0")).join("");
const cancelled = () => new DOMException("PBR material import cancelled", "AbortError");
function checkCancellation(signal?: AbortSignal) {
  if (signal?.aborted) throw cancelled();
}

/** Browser hashes/decoders have no abort API. Reject immediately on cancellation,
 * stop subsequent work, and release a bitmap if its decoder completes later. */
function cancellable<T>(operation: () => Promise<T>, signal?: AbortSignal, release?: (value: T) => void): Promise<T> {
  checkCancellation(signal);
  if (!signal) return operation();
  return new Promise((resolve, reject) => {
    let finished = false;
    const abort = () => {
      if (finished) return;
      finished = true; signal.removeEventListener("abort", abort); reject(cancelled());
    };
    signal.addEventListener("abort", abort, { once: true });
    const rejectOperation = (reason: unknown) => {
      if (finished) return;
      finished = true; signal.removeEventListener("abort", abort); reject(reason);
    };
    // Covers signals aborted while attaching the listener, without starting work.
    if (signal.aborted) { abort(); return; }
    try {
      operation().then(value => {
        if (finished) { release?.(value); return; }
        finished = true; signal.removeEventListener("abort", abort); resolve(value);
      }, rejectOperation);
    } catch (reason) { rejectOperation(reason); }
  });
}
/** Data only. Validate every declared image before the viewer can acquire any GPU resources. */
export async function importTissuePbrBundle(source: string, signal?: AbortSignal): Promise<ImportedTissuePbr> {
  checkCancellation(signal);
  if (typeof source !== "string" || source.length > MAX_BYTES) throw new Error("PBR bundle exceeds the 32 MiB import limit");
  const value = JSON.parse(source);
  checkCancellation(signal);
  if (!value || value.schema !== "viscera.tissue-pbr-bundle/v1" || !Array.isArray(value.files) || value.files.length < 7 || value.files.length > 20) throw new Error("Unsupported PBR bundle");
  const manifest = value.manifest as TissueManifest;
  materialAssets(manifest);
  if (manifest.resolution[0] > 1024) throw new Error("Local model imports support up to 1024² source maps");
  if (typeof manifest.recipe.seed !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(manifest.recipe.seed) || BigInt(manifest.recipe.seed) > 18446744073709551615n) throw new Error("PBR seed must be an exact decimal uint64 string");
  const provenance = manifest.provenance as Record<string, unknown> | undefined;
  if (!provenance || provenance.executed !== true || !Array.isArray(provenance.native_resolution)
    || provenance.native_resolution.length !== 2 || provenance.native_resolution.some((x, i) => !Number.isInteger(x) || x !== manifest.resolution[i])) throw new Error("PBR bundle lacks executed model/native-resolution provenance");
  const declared = new Map<string, { sha256: string; bytes: number }>();
  for (const asset of [...Object.values(manifest.channels), ...manifest.layers]) {
    checkCancellation(signal);
    const file = materialFile(asset.file);
    const record = asset as unknown as Record<string, unknown>;
    if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)
      || !Number.isInteger(record.bytes) || Number(record.bytes) <= 0 || Number(record.bytes) > 8 * 1024 * 1024) throw new Error("Every PBR image needs a bounded byte count and SHA-256");
    const prior = declared.get(file);
    if (prior && (prior.sha256 !== record.sha256 || prior.bytes !== record.bytes)) throw new Error("Conflicting PBR file declarations");
    declared.set(file, { sha256: record.sha256, bytes: Number(record.bytes) });
  }
  if (value.files.length !== declared.size) throw new Error("Missing or unreferenced PBR files");
  const files = new Map<string, Blob>();
  let decodedBytes = 0;
  for (const asset of value.files) {
    checkCancellation(signal);
    const file = materialFile(asset?.file), expected = declared.get(file);
    if (!expected || files.has(file) || typeof asset.pngBase64 !== "string"
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(asset.pngBase64) || asset.pngBase64.length % 4 !== 0) throw new Error("Invalid, duplicate or unreferenced PBR image");
    checkCancellation(signal);
    const binary = atob(asset.pngBase64);
    if (binary.length !== expected.bytes) throw new Error("PBR image byte count mismatch");
    decodedBytes += binary.length;
    if (decodedBytes > 24 * 1024 * 1024) throw new Error("Decoded PBR bundle exceeds memory budget");
    checkCancellation(signal);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a
      || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452
      || view.getUint32(16) !== manifest.resolution[0] || view.getUint32(20) !== manifest.resolution[1]) throw new Error("PBR PNG dimensions/header mismatch");
    const imageDigest = await cancellable(() => crypto.subtle.digest("SHA-256", bytes), signal);
    checkCancellation(signal);
    if (hex(imageDigest) !== expected.sha256) throw new Error("PBR image checksum mismatch");
    const blob = new Blob([bytes], { type: "image/png" });
    // A valid header and self-declared checksum do not establish a decodable PNG.
    // Decode before publishing the new material, so malformed imports preserve
    // the previously working surface. ImageBitmap owns temporary decoded memory.
    const decoded = await cancellable(() => createImageBitmap(blob), signal, bitmap => bitmap.close());
    try {
      checkCancellation(signal);
      if (decoded.width !== manifest.resolution[0] || decoded.height !== manifest.resolution[1]) throw new Error("Decoded PBR image dimensions mismatch");
    } finally { decoded.close(); }
    files.set(file, blob);
  }
  checkCancellation(signal);
  for (const file of declared.keys()) if (!files.has(file)) throw new Error("Missing PBR image");
  const sourceBytes = new TextEncoder().encode(source);
  const sourceDigest = await cancellable(() => crypto.subtle.digest("SHA-256", sourceBytes), signal);
  checkCancellation(signal);
  const digest = hex(sourceDigest);
  return { manifest, manifestSource: JSON.stringify(manifest), files, digest };
}
