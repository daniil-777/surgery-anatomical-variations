/** numpy's default generator, bit for bit: SeedSequence(seed) → PCG64 (XSL-RR 128/64) and every draw the atlas
 *  samplers take from it — raw 64- and 32-bit outputs, doubles and uniforms, bounded integers on numpy's 32- and
 *  64-bit Lemire paths, the ziggurat standard normal, Fisher–Yates permutation and choice without replacement.
 *  Each method is the numpy 2.4.6 routine it names (numpy/random/src/distributions/distributions.c,
 *  _generator.pyx, _bounded_integers.pyx.in), so a seed gives the browser the same draws as the API;
 *  numpyRandom.test.ts replays fixtures recorded from numpy itself. 128-bit state in BigInt; the hashes in 32-bit
 *  integer math. */
import { fma } from "./fusedMultiplyAdd";
import { FI_DOUBLE, KI_DOUBLE, WI_DOUBLE, ZIGGURAT_NOR_INV_R, ZIGGURAT_NOR_R } from "./numpyZigguratTables";

const MASK64 = (1n << 64n) - 1n;
const MASK128 = (1n << 128n) - 1n;
const MULT128 = (2549297995355413924n << 64n) | 4865540595714422341n;
const MASK52 = (1n << 52n) - 1n;
const UINT32_MAX = 0xffffffff;

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

  /** The bit generator's next_uint32: the low half of a fresh 64-bit output, then the pending high half on the next
   *  call. Every 32-bit consumer in numpy (the Lemire draws, random_interval, uint32 fills) shares this one pending
   *  half, and next_uint64 leaves it untouched. */
  nextUint32(): number {
    if (this.hasUint32) { this.hasUint32 = false; return this.uinteger; }
    const next = this.nextUint64();
    this.hasUint32 = true;
    this.uinteger = Number(next >> 32n);
    return Number(next & 0xffffffffn);
  }

  /** Generator.random(): (next_uint64 >> 11) * 2^-53 */
  nextDouble(): number { return Number(this.nextUint64() >> 11n) * (1 / 9007199254740992); }

  /** Generator.random(n): the doubles in sequence (random_standard_uniform_fill). */
  random(count: number): number[] { return Array.from({ length: count }, () => this.nextDouble()); }

  /** Generator.integers(0, 2**32, n, dtype=uint32) or uint64: the full 32-bit range is a raw next_uint32 per element. */
  uint32s(count: number): number[] { return Array.from({ length: count }, () => this.nextUint32()); }

  /** Generator.uniform(low, high, n): random_uniform's low + (high - low) · next_double, the multiply-add fused as
   *  numpy's wheel is compiled. */
  uniform(low: number, high: number, count: number): number[] {
    const range = high - low;
    return Array.from({ length: count }, () => fma(range, this.nextDouble(), low));
  }

  /** Generator.integers(low, high) with numpy's int64 default, on the closed range [low, high - 1]
   *  (random_bounded_uint64): a range below 2^32 - 1 takes Lemire's bounded draw on the shared next_uint32 stream
   *  (numpy's buffered_bounded_lemire_uint32 never touches its buffer arguments), exactly 2^32 - 1 takes a raw
   *  next_uint32, a wider range the 64-bit Lemire draw. With a count, numpy's fill loop: the same draw per element. */
  integers(low: number, high: number): number;
  integers(low: number, high: number, count: number): number[];
  integers(low: number, high: number, count?: number): number | number[] {
    const range = high - 1 - low;
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(range) || range < 0) throw new Error("integers(): low < high as safe integers");
    if (count === undefined) return low + this.boundedUint64(range);
    return Array.from({ length: count }, () => low + this.boundedUint64(range));
  }

  /** Generator.standard_normal(): numpy's ziggurat (random_standard_normal). One 64-bit output gives the layer
   *  (8 bits), the sign (1 bit) and a 52-bit magnitude; below ki[layer] the draw is rabs · wi[layer] at once (99.3%).
   *  Layer 0's tail draws two doubles per attempt for the exponential beyond ziggurat_nor_r; another layer's wedge
   *  draws one double against exp(-x²/2) (the multiply-add fused as compiled) and otherwise starts over. The tail
   *  (about 2.6e-4 of draws) is the one place the value passes through libm: V8's log1p and macOS's disagree in the
   *  last bit for ~7% of arguments, so about one draw in 10^5 lands one ulp (≤ 8.9e-16) off the API's. */
  standardNormal(): number;
  standardNormal(count: number): number[];
  standardNormal(count?: number): number | number[] {
    if (count !== undefined) return Array.from({ length: count }, () => this.standardNormal());
    for (;;) {
      const raw = this.nextUint64();
      const layer = Number(raw & 0xffn), rest = raw >> 8n;
      const rabs = Number((rest >> 1n) & MASK52);
      const magnitude = rabs * WI_DOUBLE[layer]!;
      const x = (rest & 1n) === 1n ? -magnitude : magnitude;
      if (rabs < KI_DOUBLE[layer]!) return x;
      if (layer === 0) {
        const negative = ((rest >> 9n) & 1n) === 1n; // bit 8 of rabs, the bit the C reads for the tail's sign
        for (;;) {
          const xx = -ZIGGURAT_NOR_INV_R * Math.log1p(-this.nextDouble());
          const yy = -Math.log1p(-this.nextDouble());
          if (yy + yy > xx * xx) return negative ? -(ZIGGURAT_NOR_R + xx) : ZIGGURAT_NOR_R + xx;
        }
      }
      if (fma(FI_DOUBLE[layer - 1]! - FI_DOUBLE[layer]!, this.nextDouble(), FI_DOUBLE[layer]!) < Math.exp(-0.5 * x * x)) return x;
    }
  }

  /** Generator.normal(loc, scale, n): loc + scale · standard_normal per element (random_normal), the multiply-add
   *  fused as compiled. */
  normal(loc: number, scale: number, count: number): number[] {
    return Array.from({ length: count }, () => fma(scale, this.standardNormal(), loc));
  }

  /** Generator.permutation(x) for a count or a 1-D array: a shuffled copy by numpy's shuffle fast path, Fisher–Yates
   *  from the last item down with random_interval draws. The swaps depend on the draws alone, so shuffling an array
   *  is the same as indexing it by the permutation of 0..n-1. */
  permutation(count: number): number[];
  permutation<T>(items: readonly T[]): T[];
  permutation(source: number | readonly unknown[]): unknown[] {
    const items = typeof source === "number" ? Array.from({ length: source }, (_, i) => i) : [...source];
    return fisherYates(items, 1, (max) => this.randomInterval(max));
  }

  /** Generator.choice(n, k, replace=False) as the drawn indices in numpy's order. A population over 10000 with k
   *  above a fiftieth of it tail-shuffles 0..n-1 with Lemire draws (random_bounded_uint64) and keeps the last k;
   *  otherwise Floyd's algorithm — for j from n - k to n - 1 draw v in [0, j] and take v, or j when v is already
   *  taken — followed by a Lemire Fisher–Yates of the k results. */
  choiceWithoutReplacement(populationSize: number, count: number): number[] {
    if (!Number.isInteger(count) || count < 0 || count > populationSize) throw new Error("choice(): 0 ≤ count ≤ population without replacement");
    const lemire = (max: number) => this.boundedUint64(max);
    if (populationSize > 10000 && count > Math.floor(populationSize / 50)) {
      const indices = Array.from({ length: populationSize }, (_, i) => i);
      fisherYates(indices, Math.max(populationSize - count, 1), lemire);
      return indices.slice(populationSize - count);
    }
    const taken = new Set<number>(), chosen: number[] = [];
    for (let j = populationSize - count; j < populationSize; j++) {
      const value = lemire(j);
      const pick = taken.has(value) ? j : value;
      taken.add(pick);
      chosen.push(pick);
    }
    return fisherYates(chosen, 1, lemire);
  }

  /** numpy's random_bounded_uint64 with off = 0: one draw on the closed range [0, range]. */
  private boundedUint64(range: number): number {
    if (range === 0) return 0;
    if (range === UINT32_MAX) return this.nextUint32();
    return range < UINT32_MAX ? lemire(range, 32n, () => BigInt(this.nextUint32())) : lemire(range, 64n, () => this.nextUint64());
  }

  /** numpy's random_interval(max), the shuffle's draw: next_uint32 under the smallest all-ones mask ≥ max, redrawn
   *  until it is ≤ max. (numpy moves to next_uint64 only above 2^32 - 1, beyond any pool here.) */
  private randomInterval(max: number): number {
    if (max === 0) return 0;
    if (max > UINT32_MAX) throw new Error("random_interval(): no 64-bit pools here");
    const mask = 2 ** (32 - Math.clz32(max)) - 1;
    let value: number;
    do value = u32(this.nextUint32() & mask); while (value > max);
    return value;
  }
}

/** Lemire's bounded draw (arXiv:1805.10941) as numpy writes it for 32- and 64-bit words: scale one word by
 *  range + 1, redraw while the low word is below the bias threshold, return the high word. */
function lemire(range: number, wordBits: 32n | 64n, draw: () => bigint): number {
  const mask = (1n << wordBits) - 1n, rangeExcl = BigInt(range) + 1n;
  let m = draw() * rangeExcl, leftover = m & mask;
  if (leftover < rangeExcl) {
    const threshold = (mask - BigInt(range)) % rangeExcl;
    while (leftover < threshold) { m = draw() * rangeExcl; leftover = m & mask; }
  }
  return Number(m >> wordBits);
}

/** numpy's _shuffle_raw / _shuffle_int loop: for i from the last index down to `first`, swap items[i] with
 *  items[draw(i)]. */
function fisherYates<T>(items: T[], first: number, draw: (max: number) => number): T[] {
  for (let i = items.length - 1; i >= first; i--) {
    const j = draw(i);
    const held = items[i]!;
    items[i] = items[j]!;
    items[j] = held;
  }
  return items;
}
