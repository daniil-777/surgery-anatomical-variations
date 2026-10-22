// A GLB measured and photographed in the browser before it is uploaded: geometry counts, the exporter's generator string
// (verbatim) and a 512 px still rendered off screen by the imports thumbnailer (core/imports/thumbnail.ts). Pulls in
// three.js, so it is only ever loaded through import().
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { renderThumbnail } from "../../core/imports/thumbnail";
import { PlatformError } from "../../core/types";
import { countModelStats, disposeObject, type ModelStats } from "./modelStage";

export interface ModelProbe extends ModelStats {
  thumbnail: Blob | null;
  generator: string | null;
}

export async function probeModel(blob: Blob, signal?: AbortSignal): Promise<ModelProbe> {
  const bytes = await blob.arrayBuffer();
  if (signal?.aborted) throw new PlatformError("aborted", "Cancelled.");
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes, "");
  const root = gltf.scene ?? gltf.scenes?.[0];
  if (!root) return { thumbnail: null, generator: null, vertices: 0, triangles: 0, meshes: 0 };
  try {
    root.updateMatrixWorld(true);
    const stats = countModelStats(root);
    const generator = typeof gltf.asset?.generator === "string" && gltf.asset.generator.trim() !== "" ? gltf.asset.generator : null;
    const still = await renderThumbnail(root, { size: 512, signal });
    return { ...stats, generator, thumbnail: still.blob };
  } finally {
    disposeObject(root);
  }
}
