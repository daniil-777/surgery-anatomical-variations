// Ownership of everything one analysis allocates: geometries, materials, textures, decoded ImageBitmaps, skeleton bone
// textures and object URLs. One dispose() frees all of it, and anything that arrives after disposal (a texture that
// finishes decoding late) is freed on arrival.

import * as THREE from "three";

function closeImage(image: unknown): boolean {
  if (typeof image === "object" && image !== null && "close" in image && typeof image.close === "function") {
    (image as { close(): void }).close();
    return true;
  }
  return false;
}

export class ImportResources {
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly materials = new Set<THREE.Material>();
  private readonly textures = new Set<THREE.Texture>();
  private readonly skeletons = new Set<THREE.Skeleton>();
  private readonly urls = new Set<string>();
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  trackObject(root: THREE.Object3D): void {
    root.traverse((node) => {
      const renderable = node as Partial<THREE.Mesh>;
      if (renderable.geometry instanceof THREE.BufferGeometry) this.trackGeometry(renderable.geometry);
      const material = renderable.material;
      if (Array.isArray(material)) material.forEach((entry) => this.trackMaterial(entry));
      else if (material instanceof THREE.Material) this.trackMaterial(material);
      if (node instanceof THREE.SkinnedMesh && node.skeleton) this.trackSkeleton(node.skeleton);
    });
  }

  trackGeometry(geometry: THREE.BufferGeometry): void {
    if (this.geometries.has(geometry)) return;
    this.geometries.add(geometry);
    if (this.disposed) geometry.dispose();
  }

  trackMaterial(material: THREE.Material): void {
    if (this.materials.has(material)) return;
    this.materials.add(material);
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) this.trackTexture(value);
    }
    if (this.disposed) material.dispose();
  }

  trackTexture(texture: THREE.Texture): void {
    if (this.textures.has(texture)) return;
    this.textures.add(texture);
    if (this.disposed) {
      texture.dispose();
      closeImage(texture.image);
    }
  }

  trackSkeleton(skeleton: THREE.Skeleton): void {
    if (this.skeletons.has(skeleton)) return;
    this.skeletons.add(skeleton);
    if (this.disposed) skeleton.dispose();
  }

  /** An object URL to revoke on disposal (ours, or one a loader created and never revokes). */
  trackUrl(url: string): void {
    if (this.urls.has(url)) return;
    this.urls.add(url);
    if (this.disposed) URL.revokeObjectURL(url);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) {
      texture.dispose();
      closeImage(texture.image);
    }
    for (const skeleton of this.skeletons) skeleton.dispose();
    for (const url of this.urls) URL.revokeObjectURL(url);
  }
}
