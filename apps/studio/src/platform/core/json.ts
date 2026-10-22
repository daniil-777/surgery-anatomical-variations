// Canonical JSON: the one serialisation every hash and snapshot is computed from. Keys are sorted (UTF-16 code unit
// order, as Array.prototype.sort does), there is no whitespace, and anything JSON cannot represent faithfully is
// rejected with the path to it instead of being dropped or rounded silently (JSON.stringify turns NaN into null,
// drops functions and turns Maps into {}). Values may come from a lab iframe (another realm), so nothing here uses
// instanceof: arrays are recognised with Array.isArray and objects by their [[Class]] tag.

import { PlatformError, type JsonObject, type JsonValue } from "./types";

const tagOf = (value: object): string => Object.prototype.toString.call(value);

/** A plain object from any realm (also null-prototype objects); not arrays, Maps, Dates, typed arrays … */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && tagOf(value) === "[object Object]";
}

/** Shallow check: a plain object (its members are not inspected). */
export function isJsonObject(value: unknown): value is JsonObject {
  return isPlainObject(value);
}

function invalid(path: string, problem: string): PlatformError {
  return new PlatformError("invalid_input", `${path} ${problem}`, { status: 422, detail: path });
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function childPath(path: string, key: string): string {
  return IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function describeNumber(value: number): string {
  if (Number.isNaN(value)) return "is NaN, which JSON cannot represent";
  return `is ${value > 0 ? "Infinity" : "-Infinity"}, which JSON cannot represent`;
}

function writeValue(value: unknown, path: string, out: string[], ancestors: Set<object>, convertedByToJson: boolean): void {
  switch (typeof value) {
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "number":
      if (!Number.isFinite(value)) throw invalid(path, describeNumber(value));
      out.push(JSON.stringify(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "bigint":
      throw invalid(path, "is a BigInt; store large integers as decimal strings");
    case "undefined":
      throw invalid(path, "is undefined");
    case "function":
      throw invalid(path, "is a function");
    case "symbol":
      throw invalid(path, "is a symbol");
    default:
      break;
  }
  if (value === null) {
    out.push("null");
    return;
  }
  const object = value as object;
  if (!convertedByToJson) {
    const toJSON = (object as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      // Dates and other objects that define their JSON form (as JSON.stringify honours it)
      writeValue((toJSON as (key: string) => unknown).call(object, ""), path, out, ancestors, true);
      return;
    }
  }
  if (ancestors.has(object)) throw invalid(path, "refers back to itself (a cycle)");
  ancestors.add(object);
  try {
    if (Array.isArray(object)) {
      out.push("[");
      const items = object as unknown[];
      for (let index = 0; index < items.length; index += 1) {
        if (index > 0) out.push(",");
        writeValue(items[index], `${path}[${index}]`, out, ancestors, false);
      }
      out.push("]");
      return;
    }
    const tag = tagOf(object);
    if (tag === "[object Number]" || tag === "[object String]" || tag === "[object Boolean]") {
      writeValue((object as { valueOf(): unknown }).valueOf(), path, out, ancestors, true);
      return;
    }
    if (tag !== "[object Object]") {
      throw invalid(path, `is a ${tag.slice(8, -1)}; only plain objects, arrays, strings, numbers, booleans and null are JSON`);
    }
    const record = object as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    out.push("{");
    let first = true;
    for (const key of keys) {
      const member = record[key];
      if (member === undefined) continue;
      if (!first) out.push(",");
      first = false;
      out.push(JSON.stringify(key), ":");
      writeValue(member, childPath(path, key), out, ancestors, false);
    }
    out.push("}");
  } finally {
    ancestors.delete(object);
  }
}

/**
 * Sorted keys, no whitespace. Object members that are undefined are left out (as JSON.stringify does); undefined in
 * arrays, NaN, ±Infinity, BigInt, functions, symbols, cycles and non-plain objects (Map, Set, typed arrays …) throw
 * PlatformError("invalid_input") naming the path, e.g. "state.points[3] is NaN, which JSON cannot represent".
 */
export function canonicalStringify(value: unknown, options: { path?: string } = {}): string {
  const out: string[] = [];
  writeValue(value, options.path ?? "$", out, new Set(), false);
  return out.join("");
}

/** A validated, normalised deep copy (toJSON applied, undefined members dropped). */
export function toJsonValue(value: unknown, options: { path?: string } = {}): JsonValue {
  return JSON.parse(canonicalStringify(value, options)) as JsonValue;
}

/** Structural equality of two JSON-safe values (key order does not matter). */
export function jsonEquals(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

/** JSON.parse with a PlatformError("invalid_input") that says what was being read. */
export function parseJson(text: string, what = "The data"): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new PlatformError("invalid_input", `${what} is not valid JSON.`, { status: 422, detail: what, cause: error });
  }
}

/** parseJson that also requires a top-level object. */
export function parseJsonObject(text: string, what = "The data"): JsonObject {
  const value = parseJson(text, what);
  if (!isPlainObject(value)) {
    throw new PlatformError("invalid_input", `${what} is not a JSON object.`, { status: 422, detail: what });
  }
  return value as JsonObject;
}

/** UTF-8 size of a string (what the database counts with octet_length). */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
