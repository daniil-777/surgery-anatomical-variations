import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import fixture from "../../../../tests/fixtures/tissue-pbr/software-material.tissue-pbr.json";
import { loadTissueMaps, materialAssets } from "./assets";
import type { TissueManifest } from "./contracts";

const manifest: TissueManifest = { ...fixture.manifest, resolution: [16, 16] };
const localFiles = () => new Map(fixture.files.map(file => [file.file, new Blob([Uint8Array.from(Buffer.from(file.pngBase64, "base64"))], { type: "image/png" })]));
function texture(width = 16) { const value = new THREE.Texture({ width, height: 16 }); vi.spyOn(value, "dispose"); return value; }
const created: string[] = [];
const create = vi.fn((_blob: Blob | MediaSource) => { const url = `blob:software-fixture/${created.length}`; created.push(url); return url; });
const revoke = vi.fn((_url: string) => {});
beforeEach(() => {
  created.length = 0; create.mockClear(); revoke.mockClear();
  vi.spyOn(URL, "createObjectURL").mockImplementation(create); vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
});
afterEach(() => vi.restoreAllMocks());
function assertEveryUrlRevokedOnce() {
  expect(revoke.mock.calls.map(([url]) => url).sort()).toEqual([...created].sort());
  expect(new Set(revoke.mock.calls.map(([url]) => url)).size).toBe(created.length);
}
function deferredLoader() {
  const requests: Array<{ url: string; resolve: (texture: THREE.Texture) => void; reject: (error: Error) => void }> = [];
  const load = vi.fn((url: string) => new Promise<THREE.Texture>((resolve, reject) => requests.push({ url, resolve, reject })));
  return { load, requests };
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("local PBR texture URL and GPU ownership", () => {
  it("rejects missing local files before invoking the loader or creating any blob URL", async () => {
    const files = localFiles(); files.delete("normal.png"); const load = vi.fn();
    await expect(loadTissueMaps(manifest, "https://must-not-load.example", 8, new AbortController().signal, load, files)).rejects.toThrow(/Missing imported texture/);
    expect(load).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
  });

  it("revokes successfully decoded URLs immediately while keeping textures until explicit disposal", async () => {
    const textures: THREE.Texture[] = [];
    const load = vi.fn(async (url: string) => { expect(url).toMatch(/^blob:software-fixture\//); const value = texture(); textures.push(value); return value; });
    const result = await loadTissueMaps(manifest, "https://must-not-load.example", 16, new AbortController().signal, load, localFiles());
    expect(load).toHaveBeenCalledTimes(7); expect(created).toHaveLength(materialAssets(manifest).length);
    assertEveryUrlRevokedOnce(); textures.forEach(value => expect(value.dispose).not.toHaveBeenCalled());
    expect(result.maps.substrate.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(result.maps.normal.colorSpace).toBe(THREE.NoColorSpace);
    expect(result.maps.substrate.anisotropy).toBe(8);
    result.dispose(); result.dispose(); assertEveryUrlRevokedOnce();
    textures.forEach(value => expect(value.dispose).toHaveBeenCalledTimes(1));
  });

  it("cancellation revokes pending URLs promptly and disposes every late texture once", async () => {
    const controller = new AbortController(), { load, requests } = deferredLoader();
    const pending = loadTissueMaps(manifest, "unused", 8, controller.signal, load, localFiles());
    expect(requests).toHaveLength(7);
    controller.abort(); await expect(pending).rejects.toThrow(/cancelled/); assertEveryUrlRevokedOnce();
    const late = requests.map(request => { const value = texture(); request.resolve(value); return value; });
    await settle(); late.forEach(value => expect(value.dispose).toHaveBeenCalledTimes(1)); assertEveryUrlRevokedOnce();
  });

  it("an already cancelled import creates no URLs and invokes no texture loader", async () => {
    const controller = new AbortController(); controller.abort(); const load = vi.fn();
    await expect(loadTissueMaps(manifest, "unused", 8, controller.signal, load, localFiles())).rejects.toThrow(/cancelled/);
    expect(load).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
  });

  it("a partial decode failure releases successful textures and pending URLs without waiting for hung siblings", async () => {
    const { load, requests } = deferredLoader();
    const pending = loadTissueMaps(manifest, "unused", 8, new AbortController().signal, load, localFiles());
    const acquired = texture(); requests[0]!.resolve(acquired); await settle();
    requests[1]!.reject(new Error("Texture decode failed"));
    await expect(pending).rejects.toThrow(/decode failed/); assertEveryUrlRevokedOnce();
    expect(acquired.dispose).toHaveBeenCalledTimes(1);
    const late = texture(); requests[2]!.resolve(late); await settle();
    expect(late.dispose).toHaveBeenCalledTimes(1); assertEveryUrlRevokedOnce();
  });

  it("wrong decoded dimensions revoke all URLs and release the rejected texture", async () => {
    const textures: THREE.Texture[] = [];
    const load = async () => { const value = texture(textures.length === 0 ? 32 : 16); textures.push(value); return value; };
    await expect(loadTissueMaps(manifest, "unused", 8, new AbortController().signal, load, localFiles())).rejects.toThrow(/dimensions/);
    await settle(); assertEveryUrlRevokedOnce(); textures.forEach(value => expect(value.dispose).toHaveBeenCalledTimes(1));
  });
});
