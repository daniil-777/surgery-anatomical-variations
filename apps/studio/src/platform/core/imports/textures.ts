// How loaders reach a model's companion files. Every request goes through one LoadingManager per import:
//   * the URL modifier turns references to selected files into blob: URLs, lets data:/blob: URLs through, and never
//     returns a web address (unresolved references become an empty data: URL, or stay unchanged for USDZ, whose
//     composer only follows a changed URL);
//   * for FBX and MTL textures a handler resolves, checks (format, pixel size) and decodes the image itself, so missing
//     textures are known by name and leave no half-loaded texture behind;
//   * the manager's item counters tell when every texture has settled.

import * as THREE from "three";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader.js";
import { TIFFLoader } from "three/examples/jsm/loaders/TIFFLoader.js";
import { PlatformError } from "../types";
import { blobPart, toArrayBuffer } from "./bytes";
import { ADVICE, importRefusal, throwIfAborted } from "./errors";
import { DECODABLE_IMAGES, imageKind, imageMime, imageSize } from "./images";
import { IMPORT_LIMITS } from "./limits";
import { basename, extension, isLocalUrl, isRemoteReference, type FileEntry, type FileSet } from "./paths";
import type { ImportResources } from "./resources";
import { materialTextures } from "./stats";

/** Returned for references that must not be fetched: a valid, empty, local URL. */
export const BLOCKED_URL = "data:,";

export interface LoadContextOptions {
  files: FileSet;
  /** Directory of the main file; references resolve from here. */
  baseDir: string;
  resources: ImportResources;
  /** "block" (default) maps unresolved references to BLOCKED_URL; "keep" returns them unchanged (USDZ). */
  unresolved?: "block" | "keep";
}

interface DecodedPixels {
  data: Uint8Array;
  width: number;
  height: number;
  flipY?: boolean;
}

class TextureProblem extends Error {}

function pixelsToImage(pixels: DecodedPixels): HTMLCanvasElement | DecodedPixels {
  if (typeof document === "undefined" || typeof ImageData === "undefined") return { data: pixels.data, width: pixels.width, height: pixels.height };
  const canvas = document.createElement("canvas");
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const context = canvas.getContext("2d");
  if (!context) throw new TextureProblem("failed");
  const rgba = new Uint8ClampedArray(pixels.width * pixels.height * 4);
  rgba.set(pixels.data.subarray(0, rgba.length));
  context.putImageData(new ImageData(rgba, pixels.width, pixels.height), 0, 0);
  return canvas;
}

export class LoadContext {
  readonly manager: THREE.LoadingManager;
  readonly files: FileSet;
  readonly baseDir: string;
  readonly resources: ImportResources;
  /** References to files that were not selected. */
  readonly missing = new Set<string>();
  /** Web addresses that were refused. */
  readonly remote = new Set<string>();
  /** Images in formats the preview cannot decode, as "name (KIND)". */
  readonly undecodable = new Set<string>();
  /** Images that failed to decode. */
  readonly failed = new Set<string>();
  private readonly policy: "block" | "keep";
  private readonly objectUrls = new Map<string, string>();
  private readonly fetched = new Map<string, Promise<{ bytes: Uint8Array; type: string }>>();
  private pending = 0;
  private waiters: Array<() => void> = [];
  private limitError: PlatformError | null = null;

  constructor(options: LoadContextOptions) {
    this.files = options.files;
    this.baseDir = options.baseDir;
    this.resources = options.resources;
    this.policy = options.unresolved ?? "block";
    this.manager = new THREE.LoadingManager();
    this.manager.setURLModifier((url) => this.resolveUrl(url));
    const itemStart = this.manager.itemStart;
    const itemEnd = this.manager.itemEnd;
    this.manager.itemStart = (url) => {
      this.pending++;
      itemStart(url);
    };
    this.manager.itemEnd = (url) => {
      this.pending = Math.max(0, this.pending - 1);
      itemEnd(url);
      if (this.pending === 0) this.wake();
    };
  }

  /** Blob URL of a selected file (created once, revoked with the import's resources). */
  urlFor(entry: FileEntry): string {
    const existing = this.objectUrls.get(entry.path);
    if (existing) return existing;
    const kind = imageKind(entry.bytes.subarray(0, 64), extension(entry.path));
    const url = URL.createObjectURL(new Blob([blobPart(entry.bytes)], { type: imageMime(kind) ?? "application/octet-stream" }));
    this.objectUrls.set(entry.path, url);
    this.resources.trackUrl(url);
    return url;
  }

  private resolveUrl(url: string): string {
    if (isLocalUrl(url)) return url;
    if (isRemoteReference(url)) {
      this.remote.add(url);
      return this.policy === "keep" ? url : BLOCKED_URL;
    }
    const entry = this.files.resolve(url, this.baseDir);
    if (entry) return this.urlFor(entry);
    this.missing.add(url);
    return this.policy === "keep" ? url : BLOCKED_URL;
  }

  /** Routes FBX and MTL texture requests through SelectedTextureLoader. */
  installTextureHandler(): void {
    this.manager.addHandler(/[\s\S]*/, new SelectedTextureLoader(this));
  }

  /**
   * Bytes for a texture reference, or null when it is missing (recorded). `extension` is the name's extension, or
   * for embedded media the subtype of its MIME type ("image/tga" → "tga"), since TGA has no signature.
   */
  async bytesFor(reference: string): Promise<{ bytes: Uint8Array; name: string; extension: string } | null> {
    if (isLocalUrl(reference)) {
      let pending = this.fetched.get(reference);
      if (!pending) {
        // A blob: URL here was created by the loader (FBX embedded media) and is never revoked by it.
        if (reference.startsWith("blob:")) this.resources.trackUrl(reference);
        pending = fetch(reference).then(async (response) => ({
          bytes: new Uint8Array(await response.arrayBuffer()),
          type: response.headers.get("content-type") ?? "",
        }));
        this.fetched.set(reference, pending);
      }
      const { bytes, type } = await pending;
      return { bytes, name: "embedded texture", extension: /^image\/(?:x-)?([a-z0-9]+)/i.exec(type)?.[1]?.toLowerCase() ?? "" };
    }
    if (isRemoteReference(reference)) {
      this.remote.add(reference);
      return null;
    }
    const entry = this.files.resolve(reference, this.baseDir);
    if (!entry) {
      this.missing.add(reference);
      return null;
    }
    return { bytes: entry.bytes, name: basename(entry.path), extension: extension(entry.path) };
  }

  /** Fills `texture` with the image behind `reference`. Throws TextureProblem for skipped textures. */
  async decodeInto(texture: THREE.Texture, reference: string): Promise<void> {
    const found = await this.bytesFor(reference);
    if (!found) throw new TextureProblem("missing");
    const name = found.name;
    const kind = imageKind(found.bytes.subarray(0, 65536), found.extension);
    if (!DECODABLE_IMAGES.has(kind)) {
      this.undecodable.add(`${name} (${kind === "unknown" ? "unknown format" : kind.toUpperCase()})`);
      throw new TextureProblem("undecodable");
    }
    const size = imageSize(found.bytes.subarray(0, 65536), kind);
    if (size && Math.max(size.width, size.height) > IMPORT_LIMITS.imageSide) {
      this.limitError ??= importRefusal(
        `The texture ${name} is ${size.width}×${size.height}; textures are limited to ${IMPORT_LIMITS.imageSide} pixels per side.`,
        "limit:image-size",
        { code: "limit_reached", advice: ADVICE.resizeTextures },
      );
      throw new TextureProblem("oversized");
    }
    if (kind === "tga" || kind === "tiff") {
      // Both parsers return RGBA rows top first, not a texture (the d.ts files say otherwise). In a browser the
      // pixels go into a canvas: WebGL and GLTFExporter treat it like any image (GLTFExporter would not flip raw
      // pixel data). Node has no canvas and never uploads or exports, so the pixels are kept as they are.
      const pixels =
        kind === "tga"
          ? (new TGALoader().parse(toArrayBuffer(found.bytes)) as unknown as DecodedPixels)
          : (new TIFFLoader().parse(found.bytes) as unknown as DecodedPixels);
      if (!pixels?.data || !(pixels.width > 0) || !(pixels.height > 0)) throw new TextureProblem("failed");
      texture.image = pixelsToImage(pixels);
      texture.flipY = pixels.flipY ?? true;
      texture.userData = { mimeType: "image/png" };
      texture.needsUpdate = true;
      return;
    }
    const url = URL.createObjectURL(new Blob([blobPart(found.bytes)], { type: imageMime(kind) ?? "" }));
    try {
      const image = await new THREE.ImageLoader(this.manager).loadAsync(url);
      texture.image = image;
      // GLTFExporter re-encodes with this type: photos stay JPEG (no alpha to lose), everything else PNG.
      texture.userData = { mimeType: kind === "jpeg" ? "image/jpeg" : "image/png" };
      texture.needsUpdate = true;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  recordFailure(reference: string, error: unknown): void {
    if (error instanceof TextureProblem) return;
    this.failed.add(isLocalUrl(reference) ? "embedded texture" : basename(reference.replace(/\\/g, "/")));
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** Resolves once every started request has ended (or after `timeoutMs`); throws the first texture-size refusal. */
  async idle(signal?: AbortSignal, timeoutMs = 120_000): Promise<void> {
    throwIfAborted(signal);
    if (this.pending > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(done, timeoutMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new PlatformError("aborted", "The import was cancelled.", { detail: "aborted" }));
        };
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiters.push(done);
      });
    }
    if (this.limitError) throw this.limitError;
  }

  /** Sentences for the notes: what was left out and why. */
  notes(): string[] {
    const notes: string[] = [];
    const list = (values: Iterable<string>) => {
      const all = [...new Set([...values].map((value) => basename(value.replace(/\\/g, "/")) || value))];
      return all.length > 6 ? `${all.slice(0, 6).join(", ")} and ${all.length - 6} more` : all.join(", ");
    };
    if (this.missing.size > 0) notes.push(`Textures referenced but not included, so the preview leaves them out: ${list(this.missing)}.`);
    if (this.remote.size > 0) notes.push(`Web links in the file were not followed: ${list(this.remote)}.`);
    if (this.undecodable.size > 0) notes.push(`Textures in formats the preview can't decode were left out: ${[...this.undecodable].slice(0, 6).join(", ")}.`);
    if (this.failed.size > 0) notes.push(`Textures that could not be decoded: ${list(this.failed)}.`);
    return notes;
  }
}

/**
 * The texture loader FBXLoader and MTLLoader find through LoadingManager.addHandler. It returns the Texture at once
 * (both loaders expect that) and fills it when the image is decoded; missing or unusable images leave it empty, and
 * stripEmptyTextures() then removes it from its material.
 */
export class SelectedTextureLoader extends THREE.Loader<THREE.Texture> {
  private readonly context: LoadContext;

  constructor(context: LoadContext) {
    super(context.manager);
    this.context = context;
  }

  override load(
    url: string,
    onLoad?: (texture: THREE.Texture) => void,
    _onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ): THREE.Texture {
    // FBXLoader sets a path (possibly undefined) on whichever loader it uses; MTL passes full references.
    const prefix: unknown = this.path;
    const reference = isLocalUrl(url) || typeof prefix !== "string" ? url : prefix + url;
    // A plain Texture whatever the format: TGA/TIFF pixels arrive as a canvas (see pixelsToImage).
    const texture = new THREE.Texture();
    this.context.resources.trackTexture(texture);
    this.manager.itemStart(reference);
    this.context
      .decodeInto(texture, reference)
      .then(
        () => onLoad?.(texture),
        (error: unknown) => {
          this.context.recordFailure(reference, error);
          onError?.(error);
        },
      )
      .finally(() => this.manager.itemEnd(reference));
    return texture;
  }
}

function hasPixels(texture: THREE.Texture): boolean {
  const image: unknown = texture.image;
  if (image === null || image === undefined) return false;
  if ((texture as THREE.DataTexture).isDataTexture) return Boolean((image as { data?: unknown }).data);
  return true;
}

/** Removes textures that never received pixels from their materials. Returns how many were removed. */
export function stripEmptyTextures(root: THREE.Object3D): number {
  let removed = 0;
  root.traverse((node) => {
    const material = (node as Partial<THREE.Mesh>).material;
    const materials = Array.isArray(material) ? material : material instanceof THREE.Material ? [material] : [];
    for (const entry of materials) {
      for (const texture of materialTextures(entry)) {
        if (hasPixels(texture)) continue;
        for (const [key, value] of Object.entries(entry)) {
          if (value === texture) (entry as unknown as Record<string, unknown>)[key] = null;
        }
        entry.needsUpdate = true;
        removed++;
      }
    }
  });
  return removed;
}
