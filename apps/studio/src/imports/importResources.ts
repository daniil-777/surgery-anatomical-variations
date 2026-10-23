import * as THREE from "three";

/** Budgets apply before browser image decoding / Three geometry allocation. */
export const IMPORT_LIMITS = Object.freeze({
  files: 256, sourceBytes: 128 * 1024 * 1024, jsonBytes: 16 * 1024 * 1024,
  decodedBufferBytes: 128 * 1024 * 1024, vertices: 2_000_000, triangles: 2_000_000,
  meshes: 512, materials: 256, textures: 64, nodes: 4096,
  imageSide: 8192, imagePixels: 32 * 1024 * 1024,
});
export type Triple = [number, number, number];
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Model import cancelled.", "AbortError");
}
export function boundedInteger(value: unknown, max: number, label: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid or excessive ${label}.`);
  return value;
}
export function localPath(value: string): string {
  if (!value || value.length > 1024 || /[\x00-\x1f\x7f?#]/.test(value) || /^[\\/]|^[a-z][a-z\d+.-]*:/i.test(value)) throw new Error("Only relative local file dependencies are supported.");
  let decoded: string;
  try { decoded = decodeURIComponent(value.replaceAll("\\", "/")); } catch { throw new Error("Invalid encoded local file path."); }
  if (decoded !== value.replaceAll("\\", "/") && /[%:/\\?#]/.test(decoded)) throw new Error("Ambiguous encoded local file path.");
  const parts: string[] = [];
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (!parts.length) throw new Error("A dependency escapes the selected local folder."); parts.pop(); }
    else { if (part === "__proto__" || part === "constructor" || part === "prototype") throw new Error("Unsupported file name."); parts.push(part); }
  }
  if (!parts.length) throw new Error("Invalid local file path.");
  return parts.join("/");
}
export interface SelectedFile { path: string; file: File; bytes: ArrayBuffer }
export class LocalFiles {
  readonly entries: SelectedFile[] = [];
  async read(files: readonly File[], signal?: AbortSignal) {
    if (!files.length || files.length > IMPORT_LIMITS.files) throw new Error(`Select 1–${IMPORT_LIMITS.files} model and dependency files.`);
    if (files.reduce((sum, file) => sum + file.size, 0) > IMPORT_LIMITS.sourceBytes) throw new Error("Selected files exceed the 128 MiB import limit.");
    const paths = new Set<string>();
    for (const file of files) {
      checkAbort(signal);
      const path = localPath(file.webkitRelativePath || file.name);
      if (paths.has(path.toLowerCase())) throw new Error(`Duplicate or case-ambiguous file: ${path}`);
      paths.add(path.toLowerCase());
      const bytes = await file.arrayBuffer(); checkAbort(signal);
      this.entries.push({ path, file, bytes });
    }
  }
  resolve(uri: string, parent: string): SelectedFile {
    // Validate the URI independently so a scheme cannot hide behind the parent.
    if (/^[\\/]|^[a-z][a-z\d+.-]*:/i.test(uri)) throw new Error("Remote, absolute and blob dependencies are not allowed.");
    const prefix = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/") + 1) : "";
    const path = localPath(prefix + uri);
    const exact = this.entries.find(entry => entry.path === path);
    if (exact) return exact;
    // Browser multi-file pickers omit directories. A unique basename is explicit
    // selected-file resolution, never a network fallback; ambiguous names fail.
    const basename = localPath(uri).split("/").at(-1);
    const matches = this.entries.filter(entry => !entry.path.includes("/") && entry.path === basename);
    if (matches.length === 1) return matches[0]!;
    throw new Error(`Missing local dependency: ${uri}. Select it together with the model.`);
  }
}
export function textOf(bytes: ArrayBuffer, label: string, limit = IMPORT_LIMITS.jsonBytes): string {
  if (bytes.byteLength > limit) throw new Error(`${label} exceeds its text size limit.`);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error(`${label} is not valid UTF-8 text.`); }
}
export function dataBytes(uri: string): ArrayBuffer {
  const match = /^data:(?:application\/(?:octet-stream|gltf-buffer)|image\/(?:png|jpeg));base64,([A-Za-z\d+/]*={0,2})$/.exec(uri);
  if (!match || match[1]!.length % 4 !== 0 || match[1]!.length > IMPORT_LIMITS.sourceBytes * 4 / 3 + 4) throw new Error("Unsupported or oversized embedded data URI.");
  const decoded = atob(match[1]!);
  return Uint8Array.from(decoded, char => char.charCodeAt(0)).buffer;
}
export interface ImageHeader { mime: "image/png" | "image/jpeg"; width: number; height: number }
export function imageHeader(bytes: ArrayBuffer): ImageHeader {
  const b = new Uint8Array(bytes), view = new DataView(bytes);
  let width = 0, height = 0, mime: ImageHeader["mime"];
  if (b.length >= 24 && [137,80,78,71,13,10,26,10].every((v,i) => b[i] === v) && view.getUint32(12) === 0x49484452) {
    width = view.getUint32(16); height = view.getUint32(20); mime = "image/png";
  } else if (b[0] === 255 && b[1] === 216) {
    mime = "image/jpeg";
    for (let at = 2; at + 3 < b.length;) {
      if (b[at++] !== 255) throw new Error("Malformed JPEG marker.");
      while (b[at] === 255) at++;
      const marker = b[at++]!;
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (at + 2 > b.length) break;
      const size = view.getUint16(at);
      if (size < 2 || at + size > b.length) throw new Error("Truncated JPEG image.");
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (size < 8) throw new Error("Malformed JPEG frame.");
        height = view.getUint16(at + 3); width = view.getUint16(at + 5); break;
      }
      at += size;
    }
  } else throw new Error("Textures must be PNG or JPEG. Bake other image formats when exporting.");
  boundedInteger(width, IMPORT_LIMITS.imageSide, "image width", 1);
  boundedInteger(height, IMPORT_LIMITS.imageSide, "image height", 1);
  return { mime, width, height };
}

/** Captures partial and late loader resources, including shared ImageBitmaps. */
export class ImportResources {
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private readonly images = new Set<ImageBitmap>();
  private closed = false;
  own(value: unknown): void {
    if (value instanceof THREE.BufferGeometry) {
      if (!this.geometries.has(value)) { this.geometries.add(value); if (this.closed) value.dispose(); }
    } else if (value instanceof THREE.Texture) {
      if (!this.textures.has(value)) { this.textures.add(value); if (this.closed) value.dispose(); }
      if (value.image && typeof value.image.close === "function") this.ownImage(value.image);
    } else if (value instanceof THREE.Material) {
      if (!this.materials.has(value)) { this.materials.add(value); if (this.closed) value.dispose(); }
      for (const item of Object.values(value)) if (item instanceof THREE.Texture) this.own(item);
    } else if (value instanceof THREE.Object3D) {
      value.traverse(node => {
        if (node instanceof THREE.Mesh || node instanceof THREE.Line || node instanceof THREE.Points) {
          this.own(node.geometry);
          (Array.isArray(node.material) ? node.material : [node.material]).forEach(material => this.own(material));
        }
      });
    } else if (Array.isArray(value)) value.forEach(item => this.own(item));
  }
  ownImage(image: ImageBitmap) {
    if (this.images.has(image)) return;
    this.images.add(image); if (this.closed) image.close();
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    this.geometries.forEach(value => value.dispose()); this.materials.forEach(value => value.dispose());
    this.textures.forEach(value => value.dispose()); this.images.forEach(value => value.close());
  }
}
export async function decodeImages(bytes: readonly ArrayBuffer[], resources: ImportResources, flipY: boolean, signal?: AbortSignal): Promise<ImageBitmap[]> {
  if (bytes.length > IMPORT_LIMITS.textures) throw new Error("Too many texture images.");
  const headers = bytes.map(imageHeader);
  if (headers.reduce((sum, value) => sum + value.width * value.height, 0) > IMPORT_LIMITS.imagePixels) throw new Error("Decoded textures exceed the 32 megapixel import budget.");
  if (bytes.length && typeof createImageBitmap !== "function") throw new Error("This browser cannot decode local model textures.");
  const images: ImageBitmap[] = [];
  for (const [index, buffer] of bytes.entries()) {
    checkAbort(signal);
    const header = headers[index]!;
    const image = await createImageBitmap(new Blob([buffer], { type: header.mime }), { imageOrientation: flipY ? "flipY" : "none", premultiplyAlpha: "none", colorSpaceConversion: "none" });
    resources.ownImage(image); checkAbort(signal);
    if (image.width !== header.width || image.height !== header.height) throw new Error("Decoded image dimensions disagree with its header.");
    images.push(image);
  }
  return images;
}
export async function sourceIdentity(files: readonly SelectedFile[]) {
  const sha = async (bytes: ArrayBuffer) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(v => v.toString(16).padStart(2,"0")).join("");
  const entries = [];
  for (const entry of [...files].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) entries.push({ path: entry.path, bytes: entry.bytes.byteLength, sha256: await sha(entry.bytes) });
  return { sha256: await sha(new TextEncoder().encode(JSON.stringify(entries)).buffer), files: entries };
}
