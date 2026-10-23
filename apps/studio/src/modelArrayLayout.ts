/** Validate packed model bytes before creating views. Offsets here are bytes, never elements. */
export interface ModelArrayEntry { name: string; dtype: string; shape: number[]; offset: number }
export interface ModelArraySpec { dtype: "<f4" | "<f8" | "u1"; shape: number[] }

export function validateModelArrayLayout(
  entries: readonly ModelArrayEntry[], byteLength: number, actualByteLength: number,
  expected: Readonly<Record<string, ModelArraySpec>>,
): void {
  const fail = (): never => { throw new Error("Model array schema/layout mismatch."); };
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength !== actualByteLength
    || !Array.isArray(entries) || entries.length !== Object.keys(expected).length) fail();
  const names = new Set<string>(), intervals: { start: number; end: number }[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string" || names.has(entry.name)
      || !Object.hasOwn(expected, entry.name)) fail();
    const spec = expected[entry.name]!;
    if (entry.dtype !== spec.dtype || !Array.isArray(entry.shape) || entry.shape.length !== spec.shape.length
      || entry.shape.some((n, i) => !Number.isSafeInteger(n) || n <= 0 || n !== spec.shape[i])) fail();
    const stride = spec.dtype === "<f8" ? 8 : spec.dtype === "<f4" ? 4 : 1;
    const bytes = entry.shape.reduce((a, b) => a * b, stride), end = entry.offset + bytes;
    if (!Number.isSafeInteger(entry.offset) || entry.offset < 0 || entry.offset % stride !== 0
      || !Number.isSafeInteger(bytes) || !Number.isSafeInteger(end) || end > byteLength) fail();
    names.add(entry.name);
    intervals.push({ start: entry.offset, end });
  }
  // Exporters write complete, contiguous payloads. Sorting permits metadata reordering,
  // but never aliasing, holes or unreferenced trailing bytes.
  intervals.sort((a, b) => a.start - b.start);
  let end = 0;
  for (const interval of intervals) {
    if (interval.start !== end) fail();
    end = interval.end;
  }
  if (end !== byteLength) fail();
}
