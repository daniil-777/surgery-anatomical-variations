import { describe, expect, it } from 'vitest';
import type { RankOneTerm } from './preconditioner';
import { sparseBlockPreconditioner, type NodalBlock } from './sparseBlockPreconditioner';

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let result = 0;
  for (let i = 0; i < a.length; i++) result += a[i]! * b[i]!;
  return result;
};
const norm = (a: Float64Array) => Math.hypot(...a);
const difference = (a: Float64Array, b: Float64Array) => Float64Array.from(a, (v, i) => v - b[i]!);

// Independently assemble the represented quadratic in a dense coordinate basis.
// Rank vectors are summed before their outer product, including repeated IDs.
function denseOperator(base: Float64Array, blocks: NodalBlock[], terms: RankOneTerm[]) {
  const n = base.length, matrix = new Float64Array(n * n);
  for (let i = 0; i < n; i++) matrix[n * i + i] = base[i]!;
  for (const block of blocks) {
    const ids = block.ids.flatMap(id => [3 * id, 3 * id + 1, 3 * id + 2]);
    for (let i = 0; i < ids.length; i++) for (let j = 0; j < ids.length; j++)
      matrix[n * ids[i]! + ids[j]!]! += block.values[ids.length * i + j]!;
  }
  for (const term of terms) {
    const vector = new Float64Array(n);
    term.indices.forEach((id, i) => { vector[id]! += term.coefficients[i]!; });
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++)
      matrix[n * i + j]! += term.stiffness * vector[i]! * vector[j]!;
  }
  const multiply = (x: Float64Array) => Float64Array.from(x, (_, i) => dot(matrix.subarray(n * i, n * (i + 1)), x));
  // Dense Cholesky provides an independent solve, with no sparse/PCG code reuse.
  const lower = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    let value = matrix[n * i + j]!;
    for (let k = 0; k < j; k++) value -= lower[n * i + k]! * lower[n * j + k]!;
    lower[n * i + j] = i === j ? Math.sqrt(value) : value / lower[n * j + j]!;
  }
  const solve = (input: Float64Array) => {
    const y = input.slice(), x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) y[i]! -= lower[n * i + j]! * y[j]!;
      y[i]! /= lower[n * i + i]!;
    }
    for (let i = n - 1; i >= 0; i--) {
      let value = y[i]!;
      for (let j = i + 1; j < n; j++) value -= lower[n * j + i]! * x[j]!;
      x[i] = value / lower[n * i + i]!;
    }
    return x;
  };
  return { matrix, multiply, solve };
}

function fixture() {
  const base = Float64Array.from({ length: 36 }, (_, i) => 10 + i), blocks: NodalBlock[] = [], terms: RankOneTerm[] = [];
  for (let t = 0; t < 7; t++) {
    // Nonconsecutive, overlapping node IDs catch node/coordinate mapping errors.
    const ids = [t, t + 1, t + 3], n = ids.length * 3, values = new Float64Array(n * n);
    for (let mode = 0; mode < 6; mode++) {
      const v = Float64Array.from({ length: n }, (_, i) => Math.sin(i * .93 + t * .17 + mode));
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) values[n * i + j]! += 13 * v[i]! * v[j]!;
    }
    blocks.push({ ids, values });
  }
  for (let t = 0; t < 11; t++) terms.push({
    indices: [t, t + 1, t + 7, t + 15],
    coefficients: Float64Array.from({ length: 4 }, (_, i) => Math.cos(i + t * .17)), stiffness: 100 + t,
  });
  terms.push({ indices: [2, 2, 7], coefficients: new Float64Array([1, 2, -1]), stiffness: 17 });
  return { base, blocks, terms };
}

describe('sparse positive block preconditioner', () => {
  it('represents the dense quadratic, including overlapping node blocks and repeated rank coordinates', () => {
    const { base, blocks, terms } = fixture(), dense = denseOperator(base, blocks, terms);
    const sparse = sparseBlockPreconditioner(base, blocks, terms);
    for (let i = 0; i < base.length; i++) expect(sparse.diagonal[i]).toBeCloseTo(dense.matrix[base.length * i + i]!, 10);
    for (let sample = 0; sample < 12; sample++) {
      const x = Float64Array.from(base, (_, i) => Math.sin(i * .37 + sample * .13));
      const actual = sparse.multiply(x), expected = dense.multiply(x);
      expect(norm(difference(actual, expected)) / norm(expected)).toBeLessThan(2e-12);
      expect(dot(x, actual)).toBeGreaterThan(0);
    }
  });

  it('approximately solves independent dense systems with a measured residual and positive descent', () => {
    const { base, blocks, terms } = fixture(), dense = denseOperator(base, blocks, terms);
    const sparse = sparseBlockPreconditioner(base, blocks, terms);
    for (let sample = 0; sample < 12; sample++) {
      const rhs = Float64Array.from(base, (_, i) => Math.sin(i * .37 + sample * .13));
      const actual = sparse.applyInverse(rhs), exact = dense.solve(rhs);
      // The iteration budget is finite; this residual is asserted for a known
      // moderately conditioned fixture, not claimed for arbitrary conditioning.
      expect(norm(difference(dense.multiply(actual), rhs)) / norm(rhs)).toBeLessThan(1e-4);
      expect(norm(difference(actual, exact)) / norm(exact)).toBeLessThan(3e-4);
      expect(dot(rhs, actual)).toBeGreaterThan(0);
    }
    expect(sparse.applyInverse(new Float64Array(base.length))).toEqual(new Float64Array(base.length));
  });

  it('owns its assembled coefficients and every returned vector', () => {
    const { base, blocks, terms } = fixture(), sparse = sparseBlockPreconditioner(base, blocks, terms);
    const rhs = Float64Array.from(base, (_, i) => Math.cos(i)), original = rhs.slice();
    const product = sparse.multiply(rhs), inverse = sparse.applyInverse(rhs), savedProduct = product.slice(), savedInverse = inverse.slice();
    base.fill(1);
    for (const block of blocks) { block.ids.fill(0); block.values.fill(0); }
    for (const term of terms) { term.indices.fill(0); term.coefficients.fill(100); term.stiffness = 1; }
    sparse.diagonal.fill(1000);
    expect(sparse.multiply(rhs)).toEqual(savedProduct);
    expect(sparse.applyInverse(rhs)).toEqual(savedInverse);
    sparse.applyInverse(Float64Array.from(rhs, v => -v));
    expect(product).toEqual(savedProduct); expect(inverse).toEqual(savedInverse); expect(rhs).toEqual(original);
    product.fill(0); inverse.fill(0);
    expect(sparse.multiply(rhs)).toEqual(savedProduct); expect(sparse.applyInverse(rhs)).toEqual(savedInverse);
  });

  it('keeps a finite descent fallback when roundoff destroys a block Cholesky pivot', () => {
    const sparse = sparseBlockPreconditioner(new Float64Array([1, 1, 1]), [], [
      { indices: [0, 1], coefficients: new Float64Array([1, 1]), stiffness: 1e20 },
    ]);
    const rhs = new Float64Array([1, -1, 0]), inverse = sparse.applyInverse(rhs);
    expect(sparse.diagnostics.jacobiFallbackBlocks).toBe(1);
    expect(inverse.every(Number.isFinite)).toBe(true); expect(dot(rhs, inverse)).toBeGreaterThan(0);
    // This is a graceful descent fallback, deliberately not a false assertion
    // that an ill-conditioned singular-at-machine-precision system was solved.
  });

  it('rejects malformed coefficients and vectors without corrupting later evaluations', () => {
    const base = new Float64Array([2, 3, 4]);
    for (const bad of [new Float64Array(), new Float64Array([1, 1]), new Float64Array([1, 0, 1]), new Float64Array([1, NaN, 1])])
      expect(() => sparseBlockPreconditioner(bad, [], [])).toThrow();
    for (const block of [
      { ids: [0, 0], values: new Float64Array(36) }, { ids: [1], values: new Float64Array(9) },
      { ids: [0], values: new Float64Array(8) },
      { ids: [0], values: new Float64Array([1, 2, 0, 0, 1, 0, 0, 0, 1]) },
    ]) expect(() => sparseBlockPreconditioner(base, [block], [])).toThrow();
    for (const term of [
      { indices: [0], coefficients: new Float64Array([1]), stiffness: -1 },
      { indices: [0], coefficients: new Float64Array([NaN]), stiffness: 1 },
      { indices: [3], coefficients: new Float64Array([1]), stiffness: 1 },
      { indices: [0], coefficients: new Float64Array(), stiffness: 1 },
    ]) expect(() => sparseBlockPreconditioner(base, [], [term])).toThrow();
    const sparse = sparseBlockPreconditioner(base, [], []), rhs = new Float64Array([1, -2, 3]), saved = sparse.applyInverse(rhs);
    expect(() => sparse.applyInverse(new Float64Array(2))).toThrow();
    expect(() => sparse.multiply(new Float64Array([1, NaN, 1]))).toThrow();
    expect(sparse.applyInverse(rhs)).toEqual(saved);
  });
});
