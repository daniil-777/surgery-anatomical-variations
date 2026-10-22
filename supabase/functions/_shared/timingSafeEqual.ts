// Constant-time comparison for shared secrets (Web Crypto only, so it runs in Deno and Node alike).

/** True when both byte strings are equal. Always walks the longer input, whatever the first difference is. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  const length = Math.max(a.byteLength, b.byteLength);
  let difference = a.byteLength ^ b.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Compares a presented secret with the expected one through their SHA-256 digests: equal-length inputs to the
 * constant-time loop, so neither the content nor the length of the secret leaks through timing.
 */
export async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
}
