import { describe, expect, it } from "vitest";
import { canonicalStringify, isJsonObject, isPlainObject, jsonEquals, parseJson, parseJsonObject, toJsonValue, utf8Length } from "./json";
import { PlatformError } from "./types";

/** Runs code in a fresh V8 context: objects from another realm, like a lab iframe's. */
async function foreignValue(code: string): Promise<unknown> {
  const specifier = "node:vm";
  const vm = (await import(/* @vite-ignore */ specifier)) as { runInNewContext(source: string): unknown };
  return vm.runInNewContext(`(${code})`);
}

function rejection(run: () => unknown): PlatformError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformError);
    return error as PlatformError;
  }
  throw new Error("expected a rejection");
}

describe("canonicalStringify", () => {
  it("sorts keys at every depth and writes no whitespace", () => {
    const value = { b: 1, a: { d: [3, { z: true, y: null }], c: "x" }, "": 0 };
    expect(canonicalStringify(value)).toBe('{"":0,"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  });

  it("is independent of insertion order", () => {
    expect(canonicalStringify({ x: 1, y: [1, 2], z: { b: 2, a: 1 } })).toBe(canonicalStringify({ z: { a: 1, b: 2 }, y: [1, 2], x: 1 }));
    expect(jsonEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEquals({ a: 1 }, { a: 2 })).toBe(false);
  });

  it("sorts keys by UTF-16 code units and escapes strings like JSON.stringify", () => {
    expect(canonicalStringify({ b: 1, B: 2, ä: 3, a: 4 })).toBe('{"B":2,"a":4,"b":1,"ä":3}');
    expect(canonicalStringify("line\nbreak \"quoted\" \u0001")).toBe(JSON.stringify("line\nbreak \"quoted\" \u0001"));
  });

  it("writes numbers as JavaScript does (shortest round-trip form)", () => {
    expect(canonicalStringify([0.1, 1e21, -0, 5e-7, 123456789012345680000])).toBe("[0.1,1e+21,0,5e-7,123456789012345680000]");
  });

  it("drops undefined object members but rejects undefined array items", () => {
    expect(canonicalStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
    const error = rejection(() => canonicalStringify({ list: [1, undefined] }, { path: "state" }));
    expect(error.code).toBe("invalid_input");
    expect(error.message).toBe("state.list[1] is undefined");
    expect(error.detail).toBe("state.list[1]");
  });

  it("rejects NaN and infinities with the path to them", () => {
    expect(rejection(() => canonicalStringify({ points: [0, Number.NaN] }, { path: "state" })).message).toBe(
      "state.points[1] is NaN, which JSON cannot represent",
    );
    expect(rejection(() => canonicalStringify({ "odd key": Infinity })).message).toBe('$["odd key"] is Infinity, which JSON cannot represent');
    expect(rejection(() => canonicalStringify([-Infinity])).message).toContain("-Infinity");
  });

  it("rejects functions, symbols, BigInt, cycles and non-plain objects", () => {
    expect(rejection(() => canonicalStringify({ run: () => 1 })).message).toBe("$.run is a function");
    expect(rejection(() => canonicalStringify({ tag: Symbol("x") })).message).toBe("$.tag is a symbol");
    expect(rejection(() => canonicalStringify({ seed: 2n ** 64n })).message).toContain("decimal strings");
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(rejection(() => canonicalStringify(cyclic)).message).toBe("$.self refers back to itself (a cycle)");
    expect(rejection(() => canonicalStringify({ m: new Map([[1, 2]]) })).message).toContain("is a Map");
    expect(rejection(() => canonicalStringify({ s: new Set([1]) })).message).toContain("is a Set");
    expect(rejection(() => canonicalStringify({ f: new Float32Array(2) })).message).toContain("is a Float32Array");
    expect(rejection(() => canonicalStringify(undefined)).message).toBe("$ is undefined");
  });

  it("allows shared (non-cyclic) references", () => {
    const shared = { v: 1 };
    expect(canonicalStringify({ a: shared, b: [shared, shared] })).toBe('{"a":{"v":1},"b":[{"v":1},{"v":1}]}');
  });

  it("honours toJSON (Dates) and unboxes primitives", () => {
    const date = new Date("2026-10-21T18:00:00.000Z");
    expect(canonicalStringify({ at: date, n: Object(5), s: Object("x"), t: Object(true) })).toBe(
      '{"at":"2026-10-21T18:00:00.000Z","n":5,"s":"x","t":true}',
    );
  });

  it("accepts null-prototype objects", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.b = 2;
    bare.a = 1;
    expect(canonicalStringify(bare)).toBe('{"a":1,"b":2}');
  });

  it("handles values from another realm without instanceof", async () => {
    const foreign = await foreignValue('{ b: [1, { d: 2, c: "x" }], a: new Date(0), m: null }');
    expect(foreign instanceof Object).toBe(false);
    expect(canonicalStringify(foreign)).toBe('{"a":"1970-01-01T00:00:00.000Z","b":[1,{"c":"x","d":2}],"m":null}');
    const foreignMap = await foreignValue("new Map()");
    expect(rejection(() => canonicalStringify({ m: foreignMap })).message).toContain("is a Map");
    const foreignNaN = await foreignValue("[NaN]");
    expect(rejection(() => canonicalStringify(foreignNaN)).message).toContain("NaN");
    expect(isPlainObject(foreign)).toBe(true);
    expect(isPlainObject(await foreignValue("[]"))).toBe(false);
  });
});

describe("JSON helpers", () => {
  it("toJsonValue returns a normalised deep copy", () => {
    const source = { b: [1, { y: undefined, x: new Date(0) }], a: "s" };
    const copy = toJsonValue(source);
    expect(copy).toEqual({ a: "s", b: [1, { x: "1970-01-01T00:00:00.000Z" }] });
    expect(copy).not.toBe(source);
  });

  it("parseJson / parseJsonObject explain what failed", () => {
    expect(parseJson("[1,2]")).toEqual([1, 2]);
    const bad = (() => {
      try {
        parseJson("{nope", "platform.json");
      } catch (error) {
        return error as PlatformError;
      }
      return null;
    })();
    expect(bad?.code).toBe("invalid_input");
    expect(bad?.message).toBe("platform.json is not valid JSON.");
    expect(() => parseJsonObject("[1]", "The manifest")).toThrow("The manifest is not a JSON object.");
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it("isJsonObject and utf8Length", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(utf8Length("aé😀")).toBe(1 + 2 + 4);
  });
});
