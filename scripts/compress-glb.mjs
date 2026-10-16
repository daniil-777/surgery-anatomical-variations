// scripts/compress-glb.mjs — shrinks a glTF binary for the web without changing what it says: duplicate data merged,
// positions and normals quantized (KHR_mesh_quantization: 14-bit positions keep 0.1 mm at a 1 m body; 10-bit normals),
// every buffer meshopt-encoded (EXT_meshopt_compression). Custom attributes are kept as they are (every primitive keeps
// exactly its attributes and vertex count). three.js reads the result with GLTFLoader + setMeshoptDecoder.
//   node scripts/compress-glb.mjs in.glb out.glb
import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, quantize } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

export async function compressGlb(input, output) {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(input);
  const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
  const semantics = [...new Set(prims.flatMap((p) => p.listSemantics()))];
  // the same attributes and triangles per primitive; vertices may only shrink (exact duplicates welded)
  const shape = (ps) => ps.map((p) => `${p.listSemantics().sort().join('+')}:${p.getIndices() ? p.getIndices().getCount() : -1}`);
  const before = shape(prims), verticesBefore = prims.map((p) => p.getAttribute('POSITION').getCount());
  await doc.transform(
    dedup(),
    quantize({ pattern: /^(POSITION|NORMAL)$/, quantizePosition: 14, quantizeNormal: 10 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  await io.write(output, doc);
  const back = await io.read(output);
  const outPrims = back.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
  if (shape(outPrims).join('|') !== before.join('|')) throw new Error(`${output}: primitives differ from the input (attributes or triangles)`);
  outPrims.forEach((p, i) => { if (p.getAttribute('POSITION').getCount() > verticesBefore[i]) throw new Error(`${output}: primitive ${i} gained vertices`); });
  return { meshes: back.getRoot().listMeshes().length, semantics, bytesIn: fs.statSync(input).size, bytesOut: fs.statSync(output).size,
    extensions: back.getRoot().listExtensionsUsed().map((e) => e.extensionName) };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url))) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) { console.error('usage: node scripts/compress-glb.mjs in.glb out.glb'); process.exit(2); }
  const r = await compressGlb(input, output);
  console.log(`${input} ${(r.bytesIn / 1e6).toFixed(2)} MB → ${output} ${(r.bytesOut / 1e6).toFixed(2)} MB · ${r.meshes} meshes · ${r.extensions.join(' ')}`);
}
