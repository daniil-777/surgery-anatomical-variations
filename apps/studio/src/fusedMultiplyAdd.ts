/** a·b + c with a single rounding (IEEE 754 fusedMultiplyAdd), in exact BigInt arithmetic. numpy's arm64 wheel,
 *  the API's, is compiled with clang's default -ffp-contract=on, so `loc + scale * x`, `low + range * u` and the
 *  ziggurat's wedge test run as one fma instruction there (verified: 1.2M draws equal the exactly rounded sum, none
 *  the twice-rounded one); JavaScript has no Math.fma, and the plain `a * b + c` differs in the last bit for about
 *  half of the uniform draws. Each double becomes an integer times a power of two, the sum is exact, and one
 *  round-to-nearest-even brings it back. An exact zero or a non-finite operand falls back to the plain expression,
 *  whose result is the same in those cases. An x86-64 build of the API without FMA would instead round twice. */

const view = new DataView(new ArrayBuffer(8));
const FRACTION_MASK = (1n << 52n) - 1n;

/** The double as (signed integer mantissa, exponent): value = mantissa · 2^exponent. */
function decompose(value: number): [bigint, number] {
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn), fraction = bits & FRACTION_MASK;
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  return [bits >> 63n ? -mantissa : mantissa, biased === 0 ? -1074 : biased - 1075];
}

/** mantissa · 2^exponent (mantissa ≠ 0) rounded to the nearest double, ties to even, subnormals included. */
function roundToDouble(mantissa: bigint, exponent: number): number {
  const negative = mantissa < 0n;
  let magnitude = negative ? -mantissa : mantissa;
  const bitLength = magnitude.toString(2).length;
  // the result's quantum: 53 significant bits, or 2^-1074 once the value is subnormal
  const quantum = Math.max(bitLength - 1 + exponent - 52, -1074);
  const shift = quantum - exponent;
  if (shift > 0) {
    const dropped = magnitude & ((1n << BigInt(shift)) - 1n), half = 1n << BigInt(shift - 1);
    magnitude >>= BigInt(shift);
    if (dropped > half || (dropped === half && (magnitude & 1n) === 1n)) magnitude += 1n;
  } else {
    magnitude <<= BigInt(-shift);
  }
  const result = Number(magnitude) * 2 ** quantum;
  return negative ? -result : result;
}

export function fma(a: number, b: number, c: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return a * b + c;
  const [ma, ea] = decompose(a), [mb, eb] = decompose(b), [mc, ec] = decompose(c);
  const exponent = Math.min(ea + eb, ec);
  const sum = ma * mb * (1n << BigInt(ea + eb - exponent)) + mc * (1n << BigInt(ec - exponent));
  return sum === 0n ? a * b + c : roundToDouble(sum, exponent);
}
