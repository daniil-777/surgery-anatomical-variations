// A public release is deliberately smaller than the local research library.
// Copy the exact declared 512px tissue previews; never publish a native URL whose
// contents are a preview, and never scan/copy abandoned native export directories.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const PUBLIC_COPY_MAX_BYTES = 900_000_000; // Leave room for the portfolio shell within Pages' 1GB limit.
export const conflictCopy = (name) => / \d+(\.[\w.]+)?$/.test(name);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const jsonBytes = (value) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const shaPattern = /^[0-9a-f]{64}$/;

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[?#%:\0]/.test(value)
    || value.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.') || conflictCopy(part))) {
    throw new Error(`unsafe public asset path: ${String(value)}`);
  }
  return value;
}

function regularSource(root, relative) {
  const parts = relativePath(relative).split('/');
  let current = root;
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error(`source root is not a real directory: ${root}`);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(`public asset is not a regular file through real directories: ${relative}`);
    }
  }
  return current;
}

function readMetadata(root, relative) {
  const file = regularSource(root, relative);
  if (fs.statSync(file).size > 4_000_000) throw new Error(`oversized public metadata: ${relative}`);
  const bytes = fs.readFileSync(file);
  return { value: JSON.parse(bytes.toString('utf8')), bytes, sha256: sha256(bytes), relative };
}

/** Stage only immutable, validated public assets into a fresh directory.
 * Does not mutate the source, download data, generate materials, or resize images.
 * The returned inventory excludes its own public-assets.json receipt.
 */
export function stagePublicAssets({ source, destination, maxBytes = PUBLIC_COPY_MAX_BYTES }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive safe integer');
  const root = path.resolve(source), out = path.resolve(destination);
  if (out === root || out.startsWith(root + path.sep) || root.startsWith(out + path.sep)) throw new Error('public staging must be separate from its source');
  fs.mkdirSync(out); // Exclusive: a previous/partial build must never be silently reused.
  const inventory = [], metadata = [], ignored = [], destinations = new Set();
  let totalBytes = 0;
  const reserve = (relative, bytes) => {
    relativePath(relative);
    if (destinations.has(relative)) throw new Error(`duplicate public destination: ${relative}`);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || totalBytes + bytes > maxBytes) throw new Error(`public asset byte budget exceeded at ${relative}`);
    destinations.add(relative);
    totalBytes += bytes;
    fs.mkdirSync(path.dirname(path.join(out, relative)), { recursive: true });
  };
  const write = (relative, bytes, kind) => {
    reserve(relative, bytes.length);
    fs.writeFileSync(path.join(out, relative), bytes, { flag: 'wx' });
    inventory.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes), kind });
  };
  const copy = (relative, declaration, kind, pngResolution) => {
    const file = regularSource(root, relative);
    // Warm/hydrate iCloud Drive files before taking the pre-copy stat snapshot.
    const warmup = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const probe = Buffer.alloc(1);
      fs.readSync(warmup, probe, 0, 1, 0);
    } finally {
      fs.closeSync(warmup);
    }
    const input = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let output;
    try {
      const before = fs.fstatSync(input);
      if (declaration && (!shaPattern.test(declaration.sha256) || !Number.isSafeInteger(declaration.bytes) || declaration.bytes < 0)) {
        throw new Error(`invalid byte/hash declaration: ${relative}`);
      }
      if (declaration && before.size !== declaration.bytes) throw new Error(`public asset size mismatch: ${relative}`);
      reserve(relative, before.size);
      output = fs.openSync(path.join(out, relative), 'wx');
      const hash = createHash('sha256'), buffer = Buffer.alloc(1 << 20);
      let copied = 0, count;
      while ((count = fs.readSync(input, buffer, 0, buffer.length, null)) !== 0) {
        if (copied + count > before.size) throw new Error(`public asset changed during copy: ${relative}`);
        if (pngResolution && copied === 0 && (count < 24 || !buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
          || buffer.toString('ascii', 12, 16) !== 'IHDR' || buffer.readUInt32BE(16) !== pngResolution
          || buffer.readUInt32BE(20) !== pngResolution)) throw new Error(`public preview is not a ${pngResolution}px PNG: ${relative}`);
        hash.update(buffer.subarray(0, count));
        let written = 0;
        while (written < count) written += fs.writeSync(output, buffer, written, count - written);
        copied += count;
      }
      const after = fs.fstatSync(input), digest = hash.digest('hex');
      if (copied !== before.size || before.size !== after.size || Math.abs(before.mtimeMs - after.mtimeMs) > 1
        || (declaration && digest !== declaration.sha256)) throw new Error(`public asset changed or SHA256 mismatch: ${relative}`);
      inventory.push({ path: relative, bytes: copied, sha256: digest, kind });
    } finally {
      fs.closeSync(input);
      if (output !== undefined) fs.closeSync(output);
    }
  };
  try {
    // Other existing public modes keep their assets. Ignore sync-conflict copies,
    // not arbitrary licensed inputs selected by a tissue manifest.
    const walk = (directory, prefix = '') => {
      for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = prefix + item.name;
        if (item.name.startsWith('.') || conflictCopy(item.name)) { ignored.push(relative); continue; }
        if (!prefix && item.name === 'tissue-materials') continue;
        // This deployment config is generated/preserved explicitly by the build,
        // so its dev-server source bytes must not masquerade as final assets.
        if (!prefix && item.name === 'api.json') continue;
        if (item.isSymbolicLink()) throw new Error(`symlink in public source: ${relative}`);
        if (item.isDirectory()) walk(path.join(directory, item.name), relative + '/');
        else if (item.isFile()) copy(relative, null, 'public-mode-asset');
        else throw new Error(`special file in public source: ${relative}`);
      }
    };
    walk(root);
    const catalog = readMetadata(root, 'tissue-materials/catalog.json');
    metadata.push(catalog);
    if (catalog.value.schema !== 'viscera.tissue-catalog/v1' || !Array.isArray(catalog.value.materials) || !catalog.value.materials.length) {
      throw new Error('invalid or empty tissue catalog');
    }
    const seen = new Set(), materials = [], sourceManifests = [];
    for (const entry of catalog.value.materials) {
      if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(entry.id) || seen.has(entry.id)) throw new Error('invalid or duplicate tissue id');
      seen.add(entry.id);
      const preview = relativePath(entry.preview), native = entry.manifest === null ? null : relativePath(entry.manifest);
      if (preview === native || !preview.startsWith(`${entry.id}/preview/`) || (native !== null && !native.startsWith(`${entry.id}/native/`))) {
        throw new Error(`incorrect native/preview manifest locations: ${entry.id}`);
      }
      const manifestRelative = `tissue-materials/${preview}`, manifest = readMetadata(root, manifestRelative);
      metadata.push(manifest);
      const m = manifest.value;
      if (m.schema !== 'viscera.tissue-materials/v1' || JSON.stringify(m.resolution) !== '[512,512]'
        || !m.channels || typeof m.channels !== 'object' || Array.isArray(m.channels)
        || !Object.keys(m.channels).length || !Array.isArray(m.layers)) throw new Error(`invalid 512px preview manifest: ${preview}`);
      write(manifestRelative, manifest.bytes, 'tissue-preview-manifest');
      for (const declaration of [...Object.values(m.channels), ...m.layers]) {
        if (!declaration || typeof declaration !== 'object') throw new Error(`invalid asset declaration: ${preview}`);
        const asset = relativePath(declaration.file);
        if (!asset.endsWith('.png')) throw new Error(`non-PNG tissue asset: ${asset}`);
        copy(path.posix.join('tissue-materials', path.posix.dirname(preview), asset), declaration, 'tissue-preview-map', 512);
      }
      materials.push({ ...entry, ...(entry.thumbnail ? { thumbnail: path.posix.join(path.posix.dirname(preview), m.channels.base_color.file) } : {}), manifest: null, available_resolutions: [512] });
      sourceManifests.push({ id: entry.id, preview, sha256: manifest.sha256, omitted_native_manifest: native });
    }
    const distribution = {
      kind: 'public-preview', native_available: false, preview_resolution: 512,
      source_catalog_sha256: catalog.sha256,
      note: 'This public release includes verified 512×512 authored previews. Native 4096×4096 maps remain in the local library and are not served by this release.',
    };
    const publicCatalog = jsonBytes({ ...catalog.value, materials, distribution });
    write('tissue-materials/catalog.json', publicCatalog, 'public-tissue-catalog');
    write('tissue-materials/distribution.json', jsonBytes({
      schema: 'viscera.public-tissue-distribution/v1', ...distribution,
      public_catalog_sha256: sha256(publicCatalog), materials: sourceManifests,
      files: inventory.filter((item) => item.kind.startsWith('tissue-preview')),
    }), 'public-tissue-provenance');
    for (const record of metadata) {
      if (sha256(fs.readFileSync(regularSource(root, record.relative))) !== record.sha256) throw new Error(`source metadata changed during staging: ${record.relative}`);
    }
    const receipt = {
      schema: 'viscera.public-assets/v1', tissue_distribution: distribution,
      materials: materials.length, max_bytes: maxBytes, asset_bytes: totalBytes,
      runtime_api_configuration: 'api.json is generated separately by build_public_copy.mjs and bound by the final build inventory.',
      ignored_conflict_or_hidden_entries: ignored, files: [...inventory],
    };
    write('public-assets.json', jsonBytes(receipt), 'public-assets-receipt');
    return { ...receipt, staged_bytes: totalBytes, staged_files: inventory.length };
  } catch (error) {
    fs.rmSync(out, { recursive: true, force: true });
    throw error;
  }
}

/** Source snapshot includes authored browser code, config, dependency lock and
 * release tooling; it deliberately excludes research datasets and model outputs. */
export function capturePublicBuildSources(root) {
  const files = [];
  const add = (relative) => {
    const bytes = fs.readFileSync(regularSource(root, relative));
    files.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  };
  const walk = (relative) => {
    for (const item of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.') || conflictCopy(item.name)) continue;
      const name = relative + '/' + item.name;
      if (item.isDirectory()) walk(name);
      else add(name); // regularSource rejects symlinks and special files.
    }
  };
  for (const directory of ['apps/studio/src', 'packages/ui/src', 'packages/render/src', 'packages/geometry/src']) walk(directory);
  for (const relative of [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json',
    'apps/studio/package.json', 'apps/studio/index.html', 'apps/studio/vite.config.ts',
    'apps/studio/interfaceTypography.ts',
    'apps/studio/tsconfig.json',
    'scripts/build_public_copy.mjs', 'scripts/stage_public_assets.mjs', 'scripts/compress-glb.mjs',
    'scripts/recorder_interface_review.mjs',
  ]) add(relative);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** Keep the public asset receipt truthful after the one deliberate build-time
 * geometry transformation. No map is resized, recompressed or renamed. */
export function recordPublicAtlasCompression(directory, { repairLegacyManifest = false } = {}) {
  const receiptFile = regularSource(directory, 'public-assets.json');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  if (receipt.schema !== 'viscera.public-assets/v1' || !Array.isArray(receipt.files)) throw new Error('invalid public atlas receipt');
  const relative = 'anatomy-scene/bodyparts3d-torso.glb';
  const manifestRelative = 'anatomy-scene/manifest.json';
  const linkedEntry = (name) => {
    const matching = receipt.files.filter((entry) => entry.path === name);
    if (matching.length !== 1) throw new Error(`missing or duplicate public atlas receipt entry: ${name}`);
    const entry = matching[0];
    if (!shaPattern.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) throw new Error(`invalid public atlas byte/hash declaration: ${name}`);
    return entry;
  };
  const item = linkedEntry(relative), manifestItem = linkedEntry(manifestRelative);
  const transformation = 'meshopt compression by scripts/compress-glb.mjs';
  if (item.transformation && (!repairLegacyManifest || item.transformation !== transformation)) throw new Error('missing or already-transformed public atlas receipt');
  if (repairLegacyManifest && !item.transformation) throw new Error('legacy atlas repair requires a transformed receipt');
  const source = item.transformation ? { bytes: item.source_bytes, sha256: item.source_sha256 } : { bytes: item.bytes, sha256: item.sha256 };
  if (!shaPattern.test(source.sha256) || !Number.isSafeInteger(source.bytes) || source.bytes <= 0) throw new Error('invalid original public atlas byte/hash declaration');
  const manifest = readMetadata(directory, manifestRelative);
  if (manifest.bytes.length !== manifestItem.bytes || manifest.sha256 !== manifestItem.sha256) throw new Error('original atlas manifest bytes do not match the source receipt');
  if (manifest.value.asset !== '/' + relative || !shaPattern.test(manifest.value.sha256) || manifest.value.sha256 !== source.sha256) throw new Error('original atlas manifest asset hash does not match the source receipt');
  if (manifest.value.publicCompression || manifestItem.transformation) throw new Error('already-transformed atlas manifest');
  const bytes = fs.readFileSync(regularSource(directory, relative));
  const publishedSha256 = sha256(bytes);
  // Recovery applies only to the old formatter's precisely identifiable state:
  // the GLB receipt is already final, while its unchanged source manifest still
  // names the original geometry digest. Never use repair to bless changed bytes.
  if (repairLegacyManifest && (item.bytes !== bytes.length || item.sha256 !== publishedSha256)) throw new Error('compressed atlas bytes do not match the legacy receipt');
  manifest.value.sha256 = publishedSha256;
  manifest.value.publicCompression = {
    schema: 'viscera.public-atlas-compression/v1', transformation,
    source: { asset: manifest.value.asset, bytes: source.bytes, sha256: source.sha256 },
    published: { asset: manifest.value.asset, bytes: bytes.length, sha256: publishedSha256 },
    source_manifest: { bytes: manifest.bytes.length, sha256: manifest.sha256 },
    note: 'Published encoded geometry differs from the original asset bytes; existing anatomical source, license and derivation metadata are preserved.',
  };
  const manifestBytes = jsonBytes(manifest.value);
  item.source_bytes = source.bytes;
  item.source_sha256 = source.sha256;
  item.bytes = bytes.length;
  item.sha256 = publishedSha256;
  item.transformation = transformation;
  manifestItem.source_bytes = manifest.bytes.length;
  manifestItem.source_sha256 = manifest.sha256;
  manifestItem.bytes = manifestBytes.length;
  manifestItem.sha256 = sha256(manifestBytes);
  manifestItem.transformation = 'bind published atlas digest and preserve original compression provenance';
  receipt.asset_bytes = receipt.files.reduce((sum, entry) => sum + entry.bytes, 0);
  receipt.scope = 'Final public-mode assets after atlas compression; excludes generated JavaScript, runtime api.json, API snapshots and this receipt.';
  // Validate every linkage before changing either metadata file. The final
  // receipt is written last; downstream release audits verify both files.
  fs.writeFileSync(regularSource(directory, manifestRelative), manifestBytes);
  fs.writeFileSync(receiptFile, jsonBytes(receipt));
  return { atlas: { path: relative, bytes: item.bytes, sha256: item.sha256 },
    manifest: { path: manifestRelative, bytes: manifestItem.bytes, sha256: manifestItem.sha256 },
    repaired_legacy_manifest: repairLegacyManifest };
}

/** Count the complete build, including snapshots, scripts and receipts. */
export function assertPublicBuildBudget(directory, maxBytes = PUBLIC_COPY_MAX_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('maxBytes must be a positive safe integer');
  let bytes = 0, files = 0;
  const walk = (dir) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink() || conflictCopy(item.name)) throw new Error(`unsafe file in public build: ${file}`);
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) {
        bytes += fs.statSync(file).size; files++;
        if (bytes > maxBytes) throw new Error(`public build exceeds ${maxBytes} bytes`);
      } else throw new Error(`special file in public build: ${file}`);
    }
  };
  walk(directory);
  return { files, bytes };
}
