// VSC1: the sculpture of a saved organ (DESIGN.md §9; atlas-design (e)). The studio's sculpt history keeps absolute
// positions of the whole organ (atlasSculptHistory.ts), always float32 values because the viewport sculpts its float32
// position attribute. A stroke moves a small patch, so only the vertices whose float32 bits differ from the realized
// surface are stored, each as its index and three float32 coordinates; past 75 % changed, the dense array is smaller.
// Decoding starts from the realized surface again and is bit-exact for float32 input.
//
// Layout (little-endian):
//   "VSC1"  u32 organ count (1–64)
//   per organ, 4-byte aligned:
//     u32 id byte length (1–256), UTF-8 id, zero padding to 4 bytes
//     u32 vertex count (1–2^26), u32 encoding (0 sparse, 1 dense), u32 changed vertices
//     sparse: changed × (u32 vertex index, strictly increasing; f32 x, y, z)
//     dense:  vertex count × (f32 x, y, z)
//   nothing after the last organ.

export const VSC_MAGIC = "VSC1";
/** Above this fraction of changed vertices the dense encoding is used. */
export const VSC_DENSE_FRACTION = 0.75;
export const VSC_MAX_ORGANS = 64;
export const VSC_MAX_VERTICES = 2 ** 26;
const MAX_ID_BYTES = 256;
const SPARSE = 0;
const DENSE = 1;

export interface SculptEditLike {
  organ_id: string;
  positions: ArrayLike<number>;
}

export interface SculptOrganSummary {
  organ_id: string;
  vertex_count: number;
  changed: number;
  encoding: "sparse" | "dense";
}

export interface ParsedSculptOrgan extends SculptOrganSummary {
  /** Sparse: the changed vertex indices; dense: null. */
  indices: Uint32Array | null;
  /** Sparse: 3 per changed vertex; dense: 3 per vertex. */
  values: Float32Array;
}

/** A sculpture file or edit this codec refuses (the message is fit for the UI). */
export class SculptCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SculptCodecError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function float32(values: ArrayLike<number>, what: string): Float32Array<ArrayBuffer> {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    if (!Number.isFinite(value)) throw new SculptCodecError(`${what} has a position that is not a finite number.`);
    out[i] = value;
  }
  return out;
}

function padded(length: number): number {
  return (length + 3) & ~3;
}

/** Encodes the edited organs against their realized positions (baseOf(organ id)). */
export function encodeSculpt(edits: readonly SculptEditLike[], baseOf: (organId: string) => ArrayLike<number> | undefined): { bytes: Uint8Array<ArrayBuffer>; organs: SculptOrganSummary[] } {
  if (edits.length === 0) throw new SculptCodecError("There is no sculpture to save.");
  if (edits.length > VSC_MAX_ORGANS) throw new SculptCodecError(`A sculpture can cover at most ${VSC_MAX_ORGANS} organs.`);
  const seen = new Set<string>();
  const parts = edits.map((edit) => {
    const id = encoder.encode(edit.organ_id);
    if (id.length === 0 || id.length > MAX_ID_BYTES) throw new SculptCodecError("A sculpted organ has no usable id.");
    if (seen.has(edit.organ_id)) throw new SculptCodecError(`The organ ${edit.organ_id} is sculpted twice.`);
    seen.add(edit.organ_id);
    const base = baseOf(edit.organ_id);
    if (!base) throw new SculptCodecError(`The sculpted organ ${edit.organ_id} is not in the displayed specimen.`);
    if (edit.positions.length !== base.length || base.length % 3 !== 0 || base.length === 0) {
      throw new SculptCodecError(`The sculpture of ${edit.organ_id} does not match its surface (${edit.positions.length / 3} of ${base.length / 3} vertices).`);
    }
    const vertexCount = base.length / 3;
    if (vertexCount > VSC_MAX_VERTICES) throw new SculptCodecError(`${edit.organ_id} has too many vertices to save its sculpture.`);
    const edited = float32(edit.positions, `The sculpture of ${edit.organ_id}`);
    const realized = float32(base, `The surface of ${edit.organ_id}`);
    // bit patterns, so -0 and +0 count as different and the round trip is exact to the bit
    const editedBits = new Uint32Array(edited.buffer), realizedBits = new Uint32Array(realized.buffer);
    const changed: number[] = [];
    for (let v = 0; v < vertexCount; v++) {
      const i = v * 3;
      if (editedBits[i] !== realizedBits[i] || editedBits[i + 1] !== realizedBits[i + 1] || editedBits[i + 2] !== realizedBits[i + 2]) changed.push(v);
    }
    const dense = changed.length > vertexCount * VSC_DENSE_FRACTION;
    return { organId: edit.organ_id, id, vertexCount, edited, changed, dense };
  });
  let size = 8;
  for (const part of parts) size += 4 + padded(part.id.length) + 12 + (part.dense ? part.vertexCount * 12 : part.changed.length * 16);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(encoder.encode(VSC_MAGIC), 0);
  view.setUint32(4, parts.length, true);
  let offset = 8;
  for (const part of parts) {
    view.setUint32(offset, part.id.length, true);
    bytes.set(part.id, offset + 4);
    offset += 4 + padded(part.id.length);
    view.setUint32(offset, part.vertexCount, true);
    view.setUint32(offset + 4, part.dense ? DENSE : SPARSE, true);
    view.setUint32(offset + 8, part.changed.length, true);
    offset += 12;
    if (part.dense) {
      for (let i = 0; i < part.edited.length; i++, offset += 4) view.setFloat32(offset, part.edited[i]!, true);
    } else {
      for (const v of part.changed) {
        view.setUint32(offset, v, true);
        view.setFloat32(offset + 4, part.edited[v * 3]!, true);
        view.setFloat32(offset + 8, part.edited[v * 3 + 1]!, true);
        view.setFloat32(offset + 12, part.edited[v * 3 + 2]!, true);
        offset += 16;
      }
    }
  }
  const organs = parts.map((part) => ({ organ_id: part.organId, vertex_count: part.vertexCount, changed: part.changed.length, encoding: part.dense ? "dense" as const : "sparse" as const }));
  return { bytes, organs };
}

/** Reads and checks a VSC1 file without its realized surfaces (structure, bounds, ordering, finite values). */
export function parseSculpt(bytes: Uint8Array): ParsedSculptOrgan[] {
  const corrupt = (detail: string): never => {
    throw new SculptCodecError(`The saved sculpture is damaged (${detail}).`);
  };
  if (bytes.length < 8) corrupt("too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) !== VSC_MAGIC) corrupt("not a VSC1 file");
  const count = view.getUint32(4, true);
  if (count < 1 || count > VSC_MAX_ORGANS) corrupt("organ count");
  const need = (offset: number, length: number) => {
    if (offset + length > bytes.length) corrupt("truncated");
  };
  const organs: ParsedSculptOrgan[] = [];
  const seen = new Set<string>();
  let offset = 8;
  for (let n = 0; n < count; n++) {
    need(offset, 4);
    const idLength = view.getUint32(offset, true);
    if (idLength < 1 || idLength > MAX_ID_BYTES) corrupt("organ id length");
    need(offset + 4, padded(idLength));
    let organId: string;
    try {
      organId = decoder.decode(bytes.subarray(offset + 4, offset + 4 + idLength));
    } catch {
      return corrupt("organ id is not UTF-8");
    }
    for (let i = offset + 4 + idLength; i < offset + 4 + padded(idLength); i++) if (bytes[i] !== 0) corrupt("padding");
    if (seen.has(organId)) corrupt("an organ appears twice");
    seen.add(organId);
    offset += 4 + padded(idLength);
    need(offset, 12);
    const vertexCount = view.getUint32(offset, true);
    const encoding = view.getUint32(offset + 4, true);
    const changed = view.getUint32(offset + 8, true);
    offset += 12;
    if (vertexCount < 1 || vertexCount > VSC_MAX_VERTICES) corrupt("vertex count");
    if (changed > vertexCount) corrupt("changed count");
    if (encoding === DENSE) {
      need(offset, vertexCount * 12);
      const values = new Float32Array(vertexCount * 3);
      for (let i = 0; i < values.length; i++, offset += 4) {
        const value = view.getFloat32(offset, true);
        if (!Number.isFinite(value)) corrupt("a position is not finite");
        values[i] = value;
      }
      organs.push({ organ_id: organId, vertex_count: vertexCount, changed, encoding: "dense", indices: null, values });
    } else if (encoding === SPARSE) {
      need(offset, changed * 16);
      const indices = new Uint32Array(changed);
      const values = new Float32Array(changed * 3);
      let previous = -1;
      for (let k = 0; k < changed; k++, offset += 16) {
        const index = view.getUint32(offset, true);
        if (index >= vertexCount || index <= previous) corrupt("vertex indices out of order or range");
        previous = index;
        indices[k] = index;
        for (let c = 0; c < 3; c++) {
          const value = view.getFloat32(offset + 4 + c * 4, true);
          if (!Number.isFinite(value)) corrupt("a position is not finite");
          values[k * 3 + c] = value;
        }
      }
      organs.push({ organ_id: organId, vertex_count: vertexCount, changed, encoding: "sparse", indices, values });
    } else {
      corrupt("unknown encoding");
    }
  }
  if (offset !== bytes.length) corrupt("trailing bytes");
  return organs;
}

/** The sculpted positions of one organ: its realized surface (as float32) with the stored vertices put back. */
export function sculptPositions(organ: ParsedSculptOrgan, base: ArrayLike<number>): number[] {
  if (base.length !== organ.vertex_count * 3) {
    throw new SculptCodecError(`The saved sculpture of ${organ.organ_id} has ${organ.vertex_count} vertices; the surface has ${base.length / 3}.`);
  }
  if (organ.encoding === "dense") return Array.from(organ.values);
  const positions = float32(base, `The surface of ${organ.organ_id}`);
  const indices = organ.indices!;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k]! * 3;
    positions[i] = organ.values[k * 3]!;
    positions[i + 1] = organ.values[k * 3 + 1]!;
    positions[i + 2] = organ.values[k * 3 + 2]!;
  }
  return Array.from(positions);
}

/** SHA-256 (hex) of positions as little-endian float32: identifies the surface a sculpture was recorded on. */
export async function positionsSha256(positions: ArrayLike<number>): Promise<string> {
  const values = float32(positions, "The surface");
  let bytes: Uint8Array<ArrayBuffer>;
  if (LITTLE_ENDIAN) {
    bytes = new Uint8Array(values.buffer);
  } else {
    bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i]!, true);
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
