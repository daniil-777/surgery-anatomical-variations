/** numpy's default generator, bit for bit: SeedSequence(seed) → PCG64 (XSL-RR 128/64), its 64/32-bit outputs,
 *  doubles, full-range uint32 draws and the Lemire bounded draw that `Generator.integers(1, 4)` takes. The joint flow
 *  sampler (viscera_core.atlas_joint_v2.sample_joint) draws its renderer seeds, severity band and 22 uniforms this way,
 *  so a seed gives the browser the same draws as the API. 128-bit state in BigInt; the hashes in 32-bit integer math. */

const MASK64 = (1n << 64n) - 1n;
const MASK128 = (1n << 128n) - 1n;
const MULT128 = (2549297995355413924n << 64n) | 4865540595714422341n;

const u32 = (value: number) => value >>> 0;

/** numpy.random.SeedSequence(seed).generate_state(4, uint64), as eight little-endian uint32 words. */
export function seedSequenceState(seed: number, words = 8): number[] {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("numpy seeds here are uint32");
  const entropy = [u32(seed)];
  let hashConst = 0x43b0d7e5;
  const hashmix = (value: number): number => {
    value = u32(value ^ hashConst);
    hashConst = u32(Math.imul(hashConst, 0x931e8875));
    value = u32(Math.imul(value, hashConst));
    return u32(value ^ (value >>> 16));
  };
  const mix = (x: number, y: number): number => {
    let result = u32(Math.imul(0xca01f9dd, x) - Math.imul(0x4973f715, y));
    return u32(result ^ (result >>> 16));
  };
  const pool = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) pool[i] = hashmix(i < entropy.length ? entropy[i]! : 0);
  for (let src = 0; src < 4; src++) for (let dst = 0; dst < 4; dst++) if (src !== dst) pool[dst] = mix(pool[dst]!, hashmix(pool[src]!));
  for (let src = 4; src < entropy.length; src++) for (let dst = 0; dst < 4; dst++) pool[dst] = mix(pool[dst]!, hashmix(entropy[src]!));
  let outConst = 0x8b51f9dd;
  const state: number[] = [];
  for (let i = 0; i < words; i++) {
    let value = u32(pool[i % 4]! ^ outConst);
    outConst = u32(Math.imul(outConst, 0x58f38ded));
    value = u32(Math.imul(value, outConst));
    state.push(u32(value ^ (value >>> 16)));
  }
  return state;
}

export class Pcg64 {
  private state = 0n;
  private inc = 0n;
  private hasUint32 = false;
  private uinteger = 0;

  /** numpy.random.default_rng(seed) */
  constructor(seed: number) {
    const w = seedSequenceState(seed).map(BigInt);
    const u64 = (i: number) => w[2 * i]! | (w[2 * i + 1]! << 32n);
    const initState = (u64(0) << 64n) | u64(1), initInc = (u64(2) << 64n) | u64(3);
    this.state = 0n;
    this.inc = ((initInc << 1n) | 1n) & MASK128;
    this.step();
    this.state = (this.state + initState) & MASK128;
    this.step();
  }

  private step(): void { this.state = (this.state * MULT128 + this.inc) & MASK128; }

  nextUint64(): bigint {
    this.step();
    const hi = this.state >> 64n, lo = this.state & MASK64;
    const xored = hi ^ lo, rot = Number(this.state >> 122n);
    return rot === 0 ? xored : ((xored >> BigInt(rot)) | (xored << BigInt(64 - rot))) & MASK64;
  }

  nextUint32(): number {
    if (this.hasUint32) { this.hasUint32 = false; return this.uinteger; }
    const next = this.nextUint64();
    this.hasUint32 = true;
    this.uinteger = Number(next >> 32n);
    return Number(next & 0xffffffffn);
  }

  /** (next_uint64 >> 11) * 2^-53 */
  nextDouble(): number { return Number(this.nextUint64() >> 11n) * (1 / 9007199254740992); }

  /** Generator.integers(0, 2**32, n, dtype=uint32): raw 32-bit halves. */
  uint32s(count: number): number[] { return Array.from({ length: count }, () => this.nextUint32()); }

  /** Generator.random(n) / Generator.uniform(low, high, n) */
  uniform(low: number, high: number, count: number): number[] {
    const range = high - low;
    return Array.from({ length: count }, () => low + range * this.nextDouble());
  }

  /** Generator.integers(low, high) for a 64-bit result whose range fits 32 bits: Lemire's bounded draw with the
   *  call's own 32-bit buffer of fresh 64-bit outputs (numpy's buffered_bounded_lemire_uint32). */
  integers(low: number, high: number): number {
    const range = high - 1 - low;
    if (range < 0 || range > 0xfffffffe) throw new Error("integers(): unsupported range");
    if (range === 0) return low;
    let buffer = 0n, buffered = 0;
    const draw = (): number => {
      if (buffered === 0) { buffer = this.nextUint64(); buffered = 1; } else { buffer >>= 32n; buffered -= 1; }
      return Number(buffer & 0xffffffffn);
    };
    const rangeExcl = range + 1;
    let m = BigInt(draw()) * BigInt(rangeExcl);
    let leftover = Number(m & 0xffffffffn);
    if (leftover < rangeExcl) {
      const threshold = (0xffffffff - range) % rangeExcl;
      while (leftover < threshold) { m = BigInt(draw()) * BigInt(rangeExcl); leftover = Number(m & 0xffffffffn); }
    }
    return low + Number(m >> 32n);
  }
}
