/** "Anatomy with words" (POST /api/atlas/compile) in the browser: the route's deterministic path for a disease-v2 spec,
 *  repeated in TypeScript so the public copy answers a text command exactly as the API does.
 *
 *  What the route runs for the studio's request (services/api/atlas.py compile, use_trained_language false, no trained
 *  wording bundle active — services/api/atlas_wording_model.py compile_request):
 *    1. atlas_semantic.request_guard on the spec's context; a refusal is the answer.
 *    2. atlas_disease_text_v2.compile_text (explicit disease grammar → atlas_material_text → atlas_text, whose measured
 *       dimensions are solved with scipy's bounded least squares on the template's deformed vertices); if it accepts,
 *       that is the answer.
 *    3. otherwise atlas_semantic.compile_text: parse_semantic → validate_plan (with _learned_domain_guard) → apply_plan,
 *       which hands the geometry part back to atlas_material_text as text.
 *  Every step is ported line by line below, with Python's semantics where JavaScript differs: re's Unicode \w, \d, \s
 *  and \b (CPython's own classes, exported), str.lower with its final sigma, float() on Unicode digits, round(x, 8)
 *  and format(x, "g") on the exact binary value (half-even), float repr, dict insertion order, code-point lengths and
 *  positions, pydantic's validation and dump order (and, where one reaches a message, its error text). The solver is
 *  trustRegionReflective.ts (scipy's TRF); the deformation is numpy's operation order of viscera_core.atlas
 *  deform_vertices. The data the compilers read — the Unicode classes, the profile and alias tables in dict order, the
 *  templates-v3 metadata, the material presets, the recipe defaults — is public/models/text-compiler/tables.json,
 *  written by scripts/export_text_compiler_web.py; the template vertices are the bundled reference specimens'
 *  rest_positions (equal to templates-v3 vertices_mm bit for bit for all 24 templates).
 *  atlasTextCompiler.test.ts replays the route's own answers (src/__fixtures__/text-compiler.json) and compares with
 *  the running API. The trained wording adapter (use_trained_language) stays with the API. */
import { publicUrl } from "./api";
import type { AtlasCatalog, AtlasGeneration, AtlasSpec } from "./atlas";
import { leastSquaresTrf } from "./trustRegionReflective";

export const TEXT_COMPILER_WEB_FORMAT = "viscera-atlas-text-compiler-web-1";
export const SEMANTIC_POLICY_VERSION = "atlas-wording-policy-1.0.1";
const DISEASE_TEXT_POLICY = "atlas-disease-text-2.0.0";
const SURFACE_TEXT_POLICY = "atlas-shape-material-text-2.0.0";
const GEOMETRY_TEXT_POLICY = "atlas-text-1.0.0";
const SCHEMA_VERSION = "atlas-semantic-1";
const INTERPRETATION = "authored_visual_design_not_clinical_inference";
const MAX_TEXT_LENGTH = 4000;
const DISEASE_FIELDS = ["severity", "size", "spread", "irregularity", "contrast", "count"];
const CONTROLS = ["scale_x", "scale_y", "scale_z", "bend", "twist", "taper", "asymmetry"];
const DIMENSIONS = ["width", "height", "depth"];
const MATERIAL_CONTROLS = ["tint", "pigment_contrast", "mottle_scale_mm", "wetness", "fine_detail", "structure_strength"];
const MATERIAL_BOUNDS: Record<string, [number, number]> = { tint: [-1, 1], pigment_contrast: [0, 1], mottle_scale_mm: [2, 40], wetness: [0, 1], fine_detail: [0, 1], structure_strength: [0, 1] };
const ORGANS = ["small-intestine", "large-intestine", "urinary-bladder", "gallbladder", "pancreas", "stomach", "kidney", "spleen", "liver", "heart", "brain", "lung"];
const NUMBER = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)`;   // atlas_semantic._NUMBER

// ---------------------------------------------------------------------------------------------- the exported tables
type Ranges = [number, number][];
export interface TextCompilerProfile { id: string; organ: string; label: string; pattern: string; mechanism?: string; supported: boolean; unavailable_reason: string }
export interface TextCompilerTemplate {
  template_id: string; organ: string; sex_label: string | null; laterality: string | null;
  control_limits: number[]; normalization_mm: number; artifact_sha256: string; vertex_count: number;
}
export interface TextCompilerTables {
  format: string; pydantic: string; sources: Record<string, string>; template_root: string;
  unicode: { python: string; unicodedata: string; word: Ranges; digit: Ranges; digit_zeros: number[]; space: Ranges; lower: [number, number[]][]; cased: Ranges; case_ignorable: Ranges };
  profiles: TextCompilerProfile[];
  profile_aliases: [string, string][];
  organ_aliases: [string, string][];
  disease_text_aliases: [string, string[]][];
  geometry_aliases: [string, string][];
  disease_defaults: { seed: number; severity: number; size: number; spread: number; irregularity: number; contrast: number; count: number; location: number[] };
  material_organs: string[];
  material_presets: Record<string, Record<string, number>>;
  templates: TextCompilerTemplate[];
  catalog_organs: { id: string; templates: string[] }[];
}

let cachedTables: Promise<TextCompilerTables> | null = null;
/** The tables (85 KB, 23 KB gzipped), one download shared by every caller — so it never carries a caller's abort. */
export function loadTextCompilerTables(): Promise<TextCompilerTables> {
  cachedTables ??= fetch(publicUrl("models/text-compiler/tables.json"), { cache: "default" }).then(async (response) => {
    if (!response.ok) throw new Error("The text compiler tables are not bundled with this copy.");
    const tables = await response.json() as TextCompilerTables;
    if (tables.format !== TEXT_COMPILER_WEB_FORMAT) throw new Error("Unsupported text compiler tables.");
    return tables;
  }).catch((error: unknown) => { cachedTables = null; throw error; });
  return cachedTables;
}
/** Tests and tools that hold the tables already (read from disk) hand them over instead of fetching. */
export function primeTextCompilerTables(tables: TextCompilerTables): void {
  if (tables.format !== TEXT_COMPILER_WEB_FORMAT) throw new Error("Unsupported text compiler tables.");
  cachedTables = Promise.resolve(tables);
}

// ---------------------------------------------------------------------------------------------- Python's errors
/** ValueError (pydantic's ValidationError is one): what the compilers catch and turn into a refusal. */
class PyValueError extends Error {}
/** LookupError: parse_semantic turns it into a "clarify" refusal. */
class PyLookupError extends Error {}
/** TypeError: apply_plan turns it into a refusal. */
class PyTypeError extends Error {}
/** The route's HTTP errors, with the detail text the studio would show: a request FastAPI refuses (422: text empty,
 *  over 4000 characters or not valid Unicode, a spec pydantic rejects) or a template the library lacks (404). For a
 *  text with a lone surrogate both runtimes answer 422; the API escapes rejected input in its JSON detail. */
export class TextCompilerRequestError extends Error {
  constructor(readonly status: 404 | 422, message: string) { super(message); this.name = "TextCompilerRequestError"; }
}

// ---------------------------------------------------------------------------------------------- Python's str and re
const hexCp = (cp: number) => `\\u{${cp.toString(16)}}`;
const classBody = (ranges: Ranges) => ranges.map(([lo, hi]) => (lo === hi ? hexCp(lo) : `${hexCp(lo)}-${hexCp(hi)}`)).join("");
const asciiPart = (ranges: Ranges): Ranges => ranges.filter(([lo]) => lo < 0x80).map(([lo, hi]) => [lo, Math.min(hi, 0x7f)]);
function inRanges(ranges: Ranges, cp: number): boolean {
  let lo = 0, hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, [a, b] = ranges[mid]!;
    if (cp < a) hi = mid - 1; else if (cp > b) lo = mid + 1; else return true;
  }
  return false;
}
const ASCII = /^[\x00-\x7f]*$/;
const SURROGATE = /[\ud800-\udfff]/;
/** A match of Python's re: positions in UTF-16 units of the searched string (slicing that string agrees with Python's
 *  slicing; distances are converted to code points where Python compares them), groups None when unmatched. */
interface PyMatch { start: number; end: number; group(key?: number | string): string | null }
const toMatch = (m: RegExpExecArray): PyMatch => ({
  start: m.index, end: m.index + m[0].length,
  group: (key = 0) => (typeof key === "number" ? m[key] : m.groups?.[key]) ?? null,
});
/** Code-point position of each UTF-16 position (Python's indices), the identity without astral characters. */
function codePointIndex(s: string): (i: number) => number {
  if (!SURROGATE.test(s)) return (i) => i;
  const map = new Int32Array(s.length + 1);
  let cp = 0;
  for (let i = 0; i < s.length; i++, cp++) {
    map[i] = cp;
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) map[++i] = cp;
  }
  map[s.length] = cp;
  return (i) => map[i]!;
}
/** An empty match does not end a scan: the next one is looked for a character further on, as re does. */
const stepPastEmpty = (regex: RegExp, m: RegExpExecArray, s: string) => {
  if (m[0] === "") regex.lastIndex = m.index + ((s.codePointAt(m.index) ?? 0) > 0xffff ? 2 : 1);
};
/** re.escape (Python 3.7+): the characters it escapes. */
const PY_SPECIAL = new Set(Array.from("()[]{}?*+-|^$\\.&~# \t\n\r\v\f"));
const pyEscape = (s: string) => Array.from(s, (c) => (PY_SPECIAL.has(c) ? "\\" + c : c)).join("");

/** CPython 3.11's str methods and re module for str patterns, from its own per-code-point tables. A pattern is written
 *  in Python's syntax and translated per dialect: a class escape (\w \d \s, \b's word test) only ever examines
 *  characters of the subject, so it is written as its ASCII part plus the subject's own non-ASCII members — the same
 *  decisions as CPython's full class on that subject, with a small automaton (an all-ASCII subject, the usual case,
 *  shares one dialect; the full classes would cost ~1 s of regex compilation on the first non-ASCII request). */
interface Dialect { key: string; w: string; d: string; s: string; b: string }
const dialectOf = (key: string, w: string, d: string, s: string): Dialect => ({ key, w, d, s, b: `(?:(?<=[${w}])(?![${w}])|(?<![${w}])(?=[${w}]))` });
class Python {
  private readonly ascii: { w: Ranges; d: Ranges; s: Ranges; dialect: Dialect };
  private readonly dialects = new Map<string, Dialect>();
  private readonly lowerMap: Map<number, string>;
  private readonly cache = new Map<string, RegExp>();
  private readonly stripPattern: RegExp;
  constructor(private readonly u: TextCompilerTables["unicode"]) {
    const w = asciiPart(u.word), d = asciiPart(u.digit), s = asciiPart(u.space);
    this.ascii = { w, d, s, dialect: dialectOf("ascii", classBody(w), classBody(d), classBody(s)) };
    this.lowerMap = new Map(u.lower.map(([cp, to]) => [cp, String.fromCodePoint(...to)]));
    const space = classBody(u.space);
    this.stripPattern = new RegExp(`^[${space}]+|[${space}]+$`, "gu");
  }
  /** The classes restricted to what can occur in `subject`: their ASCII part and the subject's non-ASCII members. */
  private dialect(subject: string): Dialect {
    if (ASCII.test(subject)) return this.ascii.dialect;
    const members: Record<"w" | "d" | "s", number[]> = { w: [], d: [], s: [] };
    for (const ch of new Set(subject)) {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x80) continue;
      if (inRanges(this.u.word, cp)) members.w.push(cp);
      if (inRanges(this.u.digit, cp)) members.d.push(cp);
      if (inRanges(this.u.space, cp)) members.s.push(cp);
    }
    for (const list of Object.values(members)) list.sort((a, b) => a - b);
    const key = `${members.w.join(",")}|${members.d.join(",")}|${members.s.join(",")}`;
    let dialect = this.dialects.get(key);
    if (!dialect) {
      const body = (ascii: Ranges, extra: number[]) => classBody([...ascii, ...extra.map((cp): [number, number] => [cp, cp])]);
      dialect = dialectOf(key, body(this.ascii.w, members.w), body(this.ascii.d, members.d), body(this.ascii.s, members.s));
      if (this.dialects.size > 256) this.dialects.clear();
      this.dialects.set(key, dialect);
    }
    return dialect;
  }

  /** A Python pattern as a JavaScript one (u flag): \w \d \s \b as CPython defines them, (?P<name> as (?<name>,
   *  "." without the newline, "$" also before a final newline, re.escape's escapes as literal characters. */
  private translate(source: string, k: Dialect): string {
    let out = "", inClass = false;
    for (let i = 0; i < source.length; i++) {
      const c = source[i]!;
      if (c === "\\") {
        const cp = source.codePointAt(i + 1);
        if (cp === undefined) throw new Error("A pattern ends in a backslash.");
        const n = String.fromCodePoint(cp);
        i += n.length;
        if (n === "w" || n === "d" || n === "s") { const body = n === "w" ? k.w : n === "d" ? k.d : k.s; out += inClass ? body : `[${body}]`; }
        else if (n === "W" || n === "D" || n === "S") {
          if (inClass) throw new Error("A negated class escape inside a class is not translated.");
          out += `[^${n === "W" ? k.w : n === "D" ? k.d : k.s}]`;
        } else if (n === "b") out += inClass ? "\\u{8}" : k.b;
        else if ("tnrfv".includes(n)) out += "\\" + n;
        else if (/^[A-Za-z0-9_]$/.test(n)) throw new Error(`The pattern escape \\${n} is not translated.`);
        else out += hexCp(cp);
        continue;
      }
      if (inClass) { out += c; if (c === "]") inClass = false; continue; }
      if (c === "[") {
        inClass = true; out += c;
        if (source[i + 1] === "^") { out += "^"; i++; }
        if (source[i + 1] === "]") { out += "\\]"; i++; }
        continue;
      }
      if (c === "(" && source.startsWith("(?P<", i)) { out += "(?<"; i += 3; continue; }
      if (c === ".") { out += "[^\\n]"; continue; }
      if (c === "$") { out += "(?=\\n?$)"; continue; }
      out += c;
    }
    return out;
  }
  private regex(source: string, flags: "" | "g" | "y", subject: string): RegExp {
    const dialect = this.dialect(subject);
    const key = `${dialect.key}\u0000${flags}\u0000${source}`;
    let regex = this.cache.get(key);
    if (!regex) {
      regex = new RegExp(this.translate(source, dialect), "u" + flags);
      if (dialect !== this.ascii.dialect && this.cache.size > 20000) this.cache.clear();
      this.cache.set(key, regex);
    }
    regex.lastIndex = 0;
    return regex;
  }
  /** re.search */
  search(source: string, s: string): PyMatch | null { const m = this.regex(source, "", s).exec(s); return m ? toMatch(m) : null; }
  /** re.search(...) is not None */
  test(source: string, s: string): boolean { return this.regex(source, "", s).test(s); }
  /** re.match: anchored at the start */
  match(source: string, s: string): PyMatch | null { const m = this.regex(source, "y", s).exec(s); return m ? toMatch(m) : null; }
  /** re.finditer */
  finditer(source: string, s: string): PyMatch[] {
    const regex = this.regex(source, "g", s), out: PyMatch[] = [];
    for (let m = regex.exec(s); m; m = regex.exec(s)) { out.push(toMatch(m)); stepPastEmpty(regex, m, s); }
    return out;
  }
  /** re.findall: the one group when the pattern has one ("" when it did not take part), else the whole match */
  findall(source: string, s: string): string[] {
    const regex = this.regex(source, "g", s), out: string[] = [];
    for (let m = regex.exec(s); m; m = regex.exec(s)) { out.push(m.length > 1 ? m[1] ?? "" : m[0]); stepPastEmpty(regex, m, s); }
    return out;
  }
  /** re.sub with a string (taken literally: no group references occur) or a function, count 0 = all */
  sub(source: string, repl: string | ((m: PyMatch) => string), s: string, count = 0): string {
    const regex = this.regex(source, "g", s);
    let out = "", last = 0, n = 0;
    for (let m = regex.exec(s); m; m = regex.exec(s)) {
      const next = regex.lastIndex;   // a replacement function may use this pattern itself
      out += s.slice(last, m.index) + (typeof repl === "string" ? repl : repl(toMatch(m)));
      last = m.index + m[0].length;
      regex.lastIndex = next;
      stepPastEmpty(regex, m, s);
      if (count > 0 && ++n >= count) break;
    }
    return out + s.slice(last);
  }
  /** re.split (patterns without groups) */
  split(source: string, s: string): string[] { return s.split(this.regex(source, "g", s)); }

  /** str.lower: the full lowercase mapping, U+03A3 by its final-sigma context (CPython's handle_capital_sigma). */
  lower(s: string): string {
    if (ASCII.test(s)) return s.toLowerCase();
    const cps = Array.from(s);
    let out = "";
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i]!.codePointAt(0)!;
      out += cp === 0x3a3 ? (this.finalSigma(cps, i) ? "ς" : "σ") : this.lowerMap.get(cp) ?? cps[i]!;
    }
    return out;
  }
  private finalSigma(cps: string[], i: number): boolean {
    const ignorable = (cp: number) => inRanges(this.u.case_ignorable, cp), cased = (cp: number) => inRanges(this.u.cased, cp);
    let j = i - 1, c = 0;
    for (; j >= 0; j--) { c = cps[j]!.codePointAt(0)!; if (!ignorable(c)) break; }
    let final = j >= 0 && cased(c);
    if (final && i + 1 < cps.length) {
      for (j = i + 1; j < cps.length; j++) { c = cps[j]!.codePointAt(0)!; if (!ignorable(c)) break; }
      final = j === cps.length || !cased(c);
    }
    return final;
  }
  /** str.strip() */
  strip(s: string): string { this.stripPattern.lastIndex = 0; return s.replace(this.stripPattern, ""); }
  /** str.rstrip(".!") */
  rstripDotBang(s: string): string { return s.replace(/[.!]+$/u, ""); }
  /** len(str): code points */
  len(s: string): number { let n = 0; for (const _ of s) n++; return n; }
  /** float() of a string re matched with \d (any Unicode decimal digit) */
  float(raw: string): number {
    let ascii = "";
    for (const ch of raw) { const cp = ch.codePointAt(0)!; ascii += cp < 0x80 ? ch : String(this.digit(cp)); }
    return Number(ascii);
  }
  /** int() of the same: the value (the large ones the validators refuse lose only digits that cannot matter) */
  int(raw: string): number { return this.float(raw) + 0; }
  private digit(cp: number): number {
    const zeros = this.u.digit_zeros;
    let lo = 0, hi = zeros.length - 1, zero = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (zeros[mid]! <= cp) { zero = zeros[mid]!; lo = mid + 1; } else hi = mid - 1; }
    if (zero < 0 || cp - zero > 9) throw new Error(`U+${cp.toString(16)} is not a decimal digit.`);
    return cp - zero;
  }
}

/** str.lower and str.strip as the compiler applies them (for the tests, which check them against CPython). */
export function pythonStrings(tables: TextCompilerTables): { lower(s: string): string; strip(s: string): string } {
  const py = compilerFor(tables).py;
  return { lower: (s) => py.lower(s), strip: (s) => py.strip(s) };
}

// ---------------------------------------------------------------------------------------------- Python's numbers
const F64 = new Float64Array(1), U64 = new BigUint64Array(F64.buffer);
/** |x| as an exact fraction num/den of BigInts. */
function exactFraction(x: number): [bigint, bigint] {
  F64[0] = Math.abs(x);
  const bits = U64[0]!, biased = Number((bits >> 52n) & 0x7ffn), fraction = bits & 0xfffffffffffffn;
  const [m, e] = biased === 0 ? [fraction, -1074] : [fraction | 0x10000000000000n, biased - 1075];
  return e >= 0 ? [m << BigInt(e), 1n] : [m, 1n << BigInt(-e)];
}
const POW10: bigint[] = [1n];
const pow10 = (n: number): bigint => { while (POW10.length <= n) POW10.push(POW10[POW10.length - 1]! * 10n); return POW10[n]!; };
function roundHalfEven(num: bigint, den: bigint): bigint {
  const q = num / den, twice = 2n * (num - q * den);
  return twice > den || (twice === den && (q & 1n) === 1n) ? q + 1n : q;
}
/** round(x, ndigits) for a float: the exact value rounded half-even to ndigits decimals, read back correctly rounded. */
export function pyRound(x: number, ndigits: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const [num, den] = exactFraction(x);
  const value = Number(`${roundHalfEven(num * pow10(ndigits), den)}e-${ndigits}`);
  return x < 0 ? -value : value;
}
/** format(x, "g"): six significant digits of the exact value, half-even, trailing zeros dropped, exponent outside
 *  -4 <= e < 6 written as e±XX. */
export function pyFormatG(x: number, precision = 6): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  if (x === 0) return sign + "0";
  const [num, den] = exactFraction(x);
  const below = (e: number) => (e >= 0 ? num < den * pow10(e) : num * pow10(-e) < den);   // |x| < 10^e
  let k = Math.floor(Math.log10(Math.abs(x)));
  while (below(k)) k--;
  while (!below(k + 1)) k++;
  const scale = precision - 1 - k;
  let q = scale >= 0 ? roundHalfEven(num * pow10(scale), den) : roundHalfEven(num, den * pow10(-scale));
  if (q === pow10(precision)) { q = pow10(precision - 1); k += 1; }
  const digits = q.toString().replace(/0+$/, "");
  return sign + positional(digits, k, precision, false);
}
/** repr(float), also str(float): the shortest round-trip digits, positional for exponents -4..15. */
export function pyRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  if (x === 0) return sign + "0.0";
  const [mantissa, exponent] = Math.abs(x).toExponential().split("e") as [string, string];
  return sign + positional(mantissa.replace(".", ""), Number(exponent), 16, true);
}
function positional(digits: string, k: number, limit: number, dotZero: boolean): string {
  if (k >= -4 && k < limit) {
    if (k < 0) return "0." + "0".repeat(-k - 1) + digits;
    const whole = digits.slice(0, k + 1).padEnd(k + 1, "0"), fraction = digits.slice(k + 1);
    return whole + (fraction ? "." + fraction : dotZero ? ".0" : "");
  }
  return digits[0]! + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" + (k < 0 ? "-" : "+") + String(Math.abs(k)).padStart(2, "0");
}
/** numpy.sign: +0 for either zero */
const npSign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : x === 0 ? 0 : x);

// ---------------------------------------------------------------------------------------------- SHA-256 and json.dumps
const SHA_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
/** SHA-256 of a string's UTF-8 bytes, synchronously (crypto.subtle is async and needs a secure context). */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const length = ((bytes.length + 9 + 63) >> 6) << 6;
  const data = new Uint8Array(length);
  data.set(bytes); data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(length - 4, bytes.length * 8 >>> 0); view.setUint32(length - 8, Math.floor(bytes.length / 0x20000000));
  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, "0")).join("");
}
/** json.dumps of a str (ensure_ascii): \" \\ \n \r \t \b \f, every other character outside space..~ as \uXXXX. */
const pyJsonString = (s: string) => `"${s.replace(/[\\"]|[^\x20-\x7e]/g, (c) => ({ "\\": "\\\\", '"': '\\"', "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f" } as Record<string, string>)[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}"`;
/** repr(str) for the identifiers, hashes and literals a spec carries. */
const pyReprString = (s: string) => {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  return quote + s.replace(/[\\\n\r\t]|[\x00-\x1f\x7f]/g, (c) => ({ "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t" } as Record<string, string>)[c] ?? `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`).replaceAll(quote, "\\" + quote) + quote;
};

// ---------------------------------------------------------------------------------------------- the specs (pydantic)
type Appearance = "tissue" | "source" | "clay";
interface ReferenceColorDump { version: "reference-color-1"; source_sha256: string; mask_sha256: string; organ: string; observed_srgb: number[]; strength: number; mode: "chroma" | "color" }
interface MaterialDump {
  version: "atlas-material-2.0.0"; organ: string; preset: string; seed: number; tint: number; pigment_contrast: number;
  mottle_scale_mm: number; wetness: number; fine_detail: number; structure_strength: number; reference_color?: ReferenceColorDump;
}
interface DiseaseDump { profile_id: string; seed: number; severity: number; size: number; spread: number; irregularity: number; contrast: number; count: number; location: number[] }
/** viscera_core.atlas_scene.AtlasSpec, as model_dump writes it */
interface GeometryDump { template_id: string; seed: number; controls: Record<string, number>; appearance: Appearance; template_sha256: string | null; realized_id: string | null }
/** atlas_surface_scene.SurfaceAtlasSpec: material left out when None */
interface SurfaceDump extends GeometryDump { material?: MaterialDump }
/** atlas_disease_scene_v2.DiseaseAtlasSpecV2: material and disease left out when None */
interface V2Dump extends SurfaceDump { renderer_version: "disease-v2"; disease?: DiseaseDump }
type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const HEX64 = /^[a-f0-9]{64}$/;
const TEMPLATE_ID = /^[a-z0-9-]+$/;
const UINT32_MAX = 2 ** 32 - 1;
const clone = <T>(value: T): T => structuredClone(value);
/** The value a key carries, a key holding undefined counting as absent (JSON.stringify drops it before the API). */
const own = (input: Dict, key: string): unknown => (Object.prototype.hasOwnProperty.call(input, key) ? input[key] : undefined);

/** pydantic's ValidationError: a ValueError. The message is exact for the one error a refusal can carry (the surface
 *  spec's material-needs-tissue check); the others never reach an answer and only name their fields. */
class ValidationError extends PyValueError {
  constructor(title: string, errors: string[]) {
    super(`${errors.length} validation error${errors.length === 1 ? "" : "s"} for ${title}\n${errors.join("\n")}`);
  }
}
/** repr() of a dumped spec dict: a number under "seed" is an int, every other number a float. */
function pyReprDump(value: unknown, key = ""): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "string") return pyReprString(value);
  if (typeof value === "number") return key === "seed" && Number.isInteger(value) ? String(value + 0) : pyRepr(value);
  if (Array.isArray(value)) return `[${value.map((v) => pyReprDump(v)).join(", ")}]`;
  return `{${Object.entries(value as Dict).filter(([, v]) => v !== undefined).map(([k, v]) => `${pyReprString(k)}: ${pyReprDump(v, k)}`).join(", ")}}`;
}
/** pydantic-core's input_value: a repr longer than 50 characters as its first 25 … last 24. */
const truncatedRepr = (repr: string) => (repr.length > 50 ? `${repr.slice(0, 25)}...${repr.slice(-24)}` : repr);

class Specs {
  private readonly profiles: Map<string, TextCompilerProfile>;
  private readonly errorUrl: string;
  constructor(private readonly tables: TextCompilerTables) {
    this.profiles = new Map(tables.profiles.map((p) => [p.id, p]));
    const [major, minor] = tables.pydantic.split(".");
    this.errorUrl = `https://errors.pydantic.dev/${major}.${minor}/v`;
  }
  private extra(input: Dict, allowed: string[], errors: string[]): void {
    for (const key of Object.keys(input)) if (input[key] !== undefined && !allowed.includes(key)) errors.push(`${key}\n  Extra inputs are not permitted`);
  }
  private seed(value: unknown, field: string, errors: string[]): number {
    if (value === undefined) return 42;
    if (!isInt(value)) { errors.push(`${field}\n  Input should be a valid integer`); return 0; }
    if (value < 0 || value > UINT32_MAX) errors.push(`${field}\n  Input should be ${value < 0 ? "greater than or equal to 0" : `less than or equal to ${UINT32_MAX}`}`);
    return value + 0;
  }
  private bounded(value: unknown, fallback: number, lo: number, hi: number, field: string, errors: string[]): number {
    if (value === undefined) return fallback;
    if (typeof value === "boolean" || !isNumber(value)) { errors.push(`${field}\n  Input should be a valid number`); return 0; }
    if (!Number.isFinite(value)) { errors.push(`${field}\n  Input should be a finite number`); return 0; }
    if (!(value >= lo && value <= hi)) errors.push(`${field}\n  Input should be ${value < lo ? `greater than or equal to ${lo}` : `less than or equal to ${hi}`}`);
    return value;
  }

  /** reference_color.ReferenceColor */
  referenceColor(input: unknown, path: string, errors: string[]): ReferenceColorDump | undefined {
    if (!isDict(input)) { errors.push(`${path}\n  Input should be a valid dictionary or instance of ReferenceColor`); return undefined; }
    this.extra(input, ["version", "source_sha256", "mask_sha256", "organ", "observed_srgb", "strength", "mode"], errors);
    const version = own(input, "version") ?? "reference-color-1";
    if (version !== "reference-color-1") errors.push(`${path}.version\n  Input should be 'reference-color-1'`);
    const hash = (key: string) => { const v = own(input, key); if (typeof v !== "string" || !HEX64.test(v)) errors.push(`${path}.${key}\n  String should match pattern '^[a-f0-9]{64}$'`); return String(v); };
    const source = hash("source_sha256"), mask = hash("mask_sha256");
    const organ = own(input, "organ");
    if (typeof organ !== "string" || organ.length < 1 || organ.length > 64) errors.push(`${path}.organ\n  String should have between 1 and 64 characters`);
    const rgb = own(input, "observed_srgb");
    if (!Array.isArray(rgb) || rgb.length !== 3 || rgb.some((v) => typeof v !== "number")) errors.push(`${path}.observed_srgb\n  Value error, Reference colour needs three numeric sRGB channels`);
    const observed = Array.isArray(rgb) ? rgb.map((v, i) => this.bounded(v, 0, 0, 1, `${path}.observed_srgb.${i}`, errors)) : [];
    const strength = this.bounded(own(input, "strength"), 1, 0, 1, `${path}.strength`, errors);
    const mode = own(input, "mode") ?? "chroma";
    if (mode !== "chroma" && mode !== "color") errors.push(`${path}.mode\n  Input should be 'chroma' or 'color'`);
    return { version: "reference-color-1", source_sha256: source, mask_sha256: mask, organ: String(organ), observed_srgb: observed, strength, mode: mode as "chroma" | "color" };
  }
  /** atlas_materials.MaterialRecipe (model_validate → model_dump) */
  material(input: unknown, path = "", title = "MaterialRecipe"): MaterialDump {
    const errors: string[] = [];
    const at = (key: string) => (path ? `${path}.${key}` : key);
    if (!isDict(input)) throw new ValidationError(title, [`${path || "input"}\n  Input should be a valid dictionary or instance of MaterialRecipe`]);
    this.extra(input, ["version", "organ", "preset", "seed", ...MATERIAL_CONTROLS, "reference_color"], errors);
    const version = own(input, "version") ?? "atlas-material-2.0.0";
    if (version !== "atlas-material-2.0.0") errors.push(`${at("version")}\n  Input should be 'atlas-material-2.0.0'`);
    const organ = own(input, "organ");
    if (typeof organ !== "string") errors.push(`${at("organ")}\n  Field required`);
    else if (!this.tables.material_organs.includes(organ)) errors.push(`${at("organ")}\n  Value error, Material organ is not in the declared atlas library`);
    const preset = own(input, "preset") ?? "balanced";
    if (typeof preset !== "string" || !["balanced", "soft", "rich", "moist"].includes(preset)) errors.push(`${at("preset")}\n  Input should be 'balanced', 'soft', 'rich' or 'moist'`);
    const seed = this.seed(own(input, "seed"), at("seed"), errors);
    const defaults: Record<string, number> = { tint: 0.0, pigment_contrast: 0.55, mottle_scale_mm: 16.0, wetness: 0.5, fine_detail: 0.5, structure_strength: 0.3 };
    const values: Record<string, number> = {};
    for (const key of MATERIAL_CONTROLS) {
      const raw = own(input, key);
      if (raw !== undefined && (typeof raw === "boolean" || !isNumber(raw) || !Number.isFinite(raw))) { errors.push(`${at(key)}\n  Value error, Material controls must be finite numeric values`); continue; }
      const [lo, hi] = MATERIAL_BOUNDS[key]!;
      values[key] = this.bounded(raw, defaults[key]!, lo, hi, at(key), errors);
    }
    const referenceInput = own(input, "reference_color");
    const reference = referenceInput === undefined || referenceInput === null ? undefined : this.referenceColor(referenceInput, at("reference_color"), errors);
    if (errors.length) throw new ValidationError(title, errors);
    if (reference && reference.organ !== organ) throw new ValidationError(title, [`${path || ""}${path ? "\n" : ""}  Value error, Reference colour must match the selected material organ`]);
    const dump: MaterialDump = {
      version: "atlas-material-2.0.0", organ: organ as string, preset: preset as string, seed,
      tint: values.tint!, pigment_contrast: values.pigment_contrast!, mottle_scale_mm: values.mottle_scale_mm!, wetness: values.wetness!, fine_detail: values.fine_detail!, structure_strength: values.structure_strength!,
    };
    if (reference) dump.reference_color = reference;
    return dump;
  }
  /** atlas_materials.make_recipe(organ, preset, seed) */
  makeRecipe(organ: string, preset: string, seed: number): MaterialDump {
    const values = this.tables.material_presets[preset];
    if (!values) throw new PyValueError("Unknown material preset");
    return this.material({ organ, preset, seed, ...values });
  }
  /** atlas_disease_v2.DiseaseSpecV2 */
  disease(input: unknown, path = "", title = "DiseaseSpecV2"): DiseaseDump {
    const errors: string[] = [];
    const at = (key: string) => (path ? `${path}.${key}` : key);
    if (!isDict(input)) throw new ValidationError(title, [`${path || "input"}\n  Input should be a valid dictionary or instance of DiseaseSpecV2`]);
    this.extra(input, ["profile_id", "seed", ...DISEASE_FIELDS, "location"], errors);
    const profileId = own(input, "profile_id");
    if (typeof profileId !== "string") errors.push(`${at("profile_id")}\n  Field required`);
    else if (profileId.length < 1 || profileId.length > 100 || !this.profiles.get(profileId)?.supported) errors.push(`${at("profile_id")}\n  Value error, Unknown or internal-only disease-v2 surface profile`);
    const d = this.tables.disease_defaults;
    const seed = this.seed(own(input, "seed"), at("seed"), errors);
    const controls: Record<string, number> = {};
    for (const key of ["severity", "size", "spread", "irregularity", "contrast"]) {
      const raw = own(input, key);
      if (raw !== undefined && (typeof raw === "boolean" || !isNumber(raw))) { errors.push(`${at(key)}\n  Value error, Disease controls must be numeric`); continue; }
      controls[key] = this.bounded(raw, d[key as "severity"], 0, 1, at(key), errors);
    }
    const countInput = own(input, "count");
    const count = countInput === undefined ? d.count : countInput;
    if (!isInt(count)) errors.push(`${at("count")}\n  Input should be a valid integer`);
    else if (count < 1 || count > 8) errors.push(`${at("count")}\n  Input should be ${count < 1 ? "greater than or equal to 1" : "less than or equal to 8"}`);
    const locationInput = own(input, "location") ?? d.location;
    if (!Array.isArray(locationInput) || locationInput.length !== 3 || locationInput.some((v) => typeof v !== "number" || !Number.isFinite(v) || !(v >= -1 && v <= 1)))
      errors.push(`${at("location")}\n  Value error, Location must be three finite coordinates in [-1,1]`);
    if (errors.length) throw new ValidationError(title, errors);
    return {
      profile_id: profileId as string, seed, severity: controls.severity!, size: controls.size!, spread: controls.spread!,
      irregularity: controls.irregularity!, contrast: controls.contrast!, count: (count as number) + 0, location: (locationInput as number[]).slice(),
    };
  }
  /** DiseaseSpecV2(profile_id=..., seed=...).model_dump(mode="json") */
  diseaseDefaults(profileId: string, seed: number): DiseaseDump { return this.disease({ profile_id: profileId, seed }); }

  /** atlas_scene.AtlasSpec, SurfaceAtlasSpec and DiseaseAtlasSpecV2 — one validator, as the three models nest. */
  private spec(input: unknown, kind: "geometry" | "surface" | "v2", title: string): V2Dump {
    if (!isDict(input)) throw new ValidationError(title, ["  Input should be a valid dictionary or instance of " + title]);
    const errors: string[] = [];
    const allowed = ["template_id", "seed", "controls", "appearance", "template_sha256", "realized_id"];
    if (kind !== "geometry") allowed.push("material");
    if (kind === "v2") allowed.push("renderer_version", "disease");
    this.extra(input, allowed, errors);
    const templateId = own(input, "template_id");
    if (typeof templateId !== "string") errors.push("template_id\n  Field required");
    else if (templateId.length < 1 || templateId.length > 100 || !TEMPLATE_ID.test(templateId)) errors.push("template_id\n  String should match pattern '^[a-z0-9-]+$'");
    const seed = this.seed(own(input, "seed"), "seed", errors);
    // AtlasSpec.valid_controls: known names, finite numbers in [-1,1], every name filled in CONTROL_NAMES order
    const controlsInput = own(input, "controls");
    let controls: Record<string, number> = Object.fromEntries(CONTROLS.map((k) => [k, 0.0]));
    if (controlsInput !== undefined) {
      if (!isDict(controlsInput) || Object.keys(controlsInput).some((k) => !CONTROLS.includes(k))) errors.push("controls\n  Value error, Unknown atlas shape controls");
      else if (Object.values(controlsInput).some((a) => typeof a !== "number" || !Number.isFinite(a) || !(a >= -1 && a <= 1))) errors.push("controls\n  Value error, Shape controls must be finite numbers in [-1,1]");
      else controls = Object.fromEntries(CONTROLS.map((k) => [k, (own(controlsInput, k) as number | undefined) ?? 0.0]));
    }
    const appearance = own(input, "appearance") ?? "tissue";
    if (appearance !== "tissue" && appearance !== "source" && appearance !== "clay") errors.push("appearance\n  Input should be 'tissue', 'source' or 'clay'");
    const optionalHash = (key: string): string | null => {
      const v = own(input, key);
      if (v === undefined || v === null) return null;
      if (typeof v !== "string" || !HEX64.test(v)) errors.push(`${key}\n  String should match pattern '^[a-f0-9]{64}$'`);
      return String(v);
    };
    const templateSha = optionalHash("template_sha256"), realized = optionalHash("realized_id");
    let material: MaterialDump | undefined;
    const materialInput = kind === "geometry" ? undefined : own(input, "material");
    if (materialInput !== undefined && materialInput !== null) {
      try { material = this.material(materialInput, "material"); } catch (error) { if (error instanceof ValidationError) errors.push(error.message.split("\n").slice(1).join("\n")); else throw error; }
    }
    let disease: DiseaseDump | undefined;
    if (kind === "v2") {
      if (own(input, "renderer_version") !== "disease-v2") errors.push("renderer_version\n  Input should be 'disease-v2'");
      const diseaseInput = own(input, "disease");
      if (diseaseInput !== undefined && diseaseInput !== null) {
        try { disease = this.disease(diseaseInput, "disease"); } catch (error) { if (error instanceof ValidationError) errors.push(error.message.split("\n").slice(1).join("\n")); else throw error; }
      }
    }
    if (errors.length) throw new ValidationError(title, errors);
    // SurfaceAtlasSpec.material_mode (mode="after"): the one error whose text a refusal carries, so pydantic's own
    if (material && appearance !== "tissue")
      throw new ValidationError(title, [`  Value error, Authored material requires tissue appearance [type=value_error, input_value=${truncatedRepr(pyReprDump(input))}, input_type=dict]\n    For further information visit ${this.errorUrl}/value_error`]);
    const dump: V2Dump = { template_id: templateId as string, seed, controls, appearance: appearance as Appearance, template_sha256: templateSha, realized_id: realized } as V2Dump;
    if (material) dump.material = material;
    if (kind === "v2") { dump.renderer_version = "disease-v2"; if (disease) dump.disease = disease; }
    return dump;
  }
  geometry(input: unknown): GeometryDump { return this.spec(input, "geometry", "AtlasSpec"); }
  surface(input: unknown): SurfaceDump { return this.spec(input, "surface", "SurfaceAtlasSpec"); }
  v2(input: unknown): V2Dump { return this.spec(input, "v2", "DiseaseAtlasSpecV2"); }
}
/** model_dump order of the three spec models, dropping the None material and disease */
function dumpSpec(spec: V2Dump | SurfaceDump | GeometryDump, kind: "geometry" | "surface" | "v2"): Dict {
  const out: Dict = { template_id: spec.template_id, seed: spec.seed, controls: { ...spec.controls }, appearance: spec.appearance, template_sha256: spec.template_sha256, realized_id: spec.realized_id };
  const s = spec as V2Dump;
  if (kind !== "geometry" && s.material) out.material = clone(s.material);
  if (kind === "v2") { out.renderer_version = "disease-v2"; if (s.disease) out.disease = clone(s.disease); }
  return out;
}
/** geometry_spec(): AtlasSpec.model_validate(self.model_dump(exclude={"material"})) */
const geometryOf = (spec: SurfaceDump): GeometryDump => ({ template_id: spec.template_id, seed: spec.seed, controls: { ...spec.controls }, appearance: spec.appearance, template_sha256: spec.template_sha256, realized_id: spec.realized_id });
/** surface_spec(): SurfaceAtlasSpec.model_validate(self.model_dump(exclude={"disease", "renderer_version"})) */
const surfaceOf = (specs: Specs, spec: V2Dump): SurfaceDump => specs.surface(dumpSpec(spec, "surface"));

// ---------------------------------------------------------------------------------------------- measured extents
/** np.ptp(deform_vertices(vertices_mm, controls, limits, normalization_mm), axis=0) in numpy's operation order: scale,
 *  z-conditioned taper and twist, bend (c3 · tanh(z)², the square first), asymmetry shear; all zero returns the rest. */
export function deformedExtents(rest: ArrayLike<number>, controls: Record<string, number>, limits: ArrayLike<number>, normalizationMm: number): [number, number, number] {
  const c = CONTROLS.map((name, i) => (controls[name] ?? 0) * limits[i]!);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number, z: number) => {
    if (x < lo[0]!) lo[0] = x; if (x > hi[0]!) hi[0] = x;
    if (y < lo[1]!) lo[1] = y; if (y > hi[1]!) hi[1] = y;
    if (z < lo[2]!) lo[2] = z; if (z > hi[2]!) hi[2] = z;
  };
  if (c.every((v) => v === 0)) for (let i = 0; i < rest.length; i += 3) add(rest[i]!, rest[i + 1]!, rest[i + 2]!);
  else {
    const e0 = Math.exp(c[0]!), e1 = Math.exp(c[1]!), e2 = Math.exp(c[2]!), bend = c[3]!, twist = c[4]!, taper = c[5]!, shear = c[6]!;
    for (let i = 0; i < rest.length; i += 3) {
      let x = rest[i]! / normalizationMm * e0, y = rest[i + 1]! / normalizationMm * e1;
      const z = rest[i + 2]! / normalizationMm * e2, t = Math.tanh(z), grow = Math.exp(taper * t);
      x *= grow; y *= grow;
      const angle = twist * t, cs = Math.cos(angle), sn = Math.sin(angle);
      const qx = cs * x - sn * y + bend * (t * t), qy = sn * x + cs * y;
      add(qx * normalizationMm, qy * normalizationMm, (z + shear * Math.tanh(qx)) * normalizationMm);
    }
  }
  return [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!];
}

// ---------------------------------------------------------------------------------------------- one compilation
type Result = Dict & { status: string; message: string };
interface Op { op: string; field?: string; value?: number | string }
interface Plan { schema_version: string; status: string; operations: Op[]; message: string; interpretation: string }
interface Context { organ: string | null; disease: DiseaseDump | null; controls: Record<string, number>; material: MaterialDump | null; appearance: string; renderer_version: string }
const byLengthDesc = <T>(py: Python, items: readonly T[], key: (item: T) => string): T[] => [...items].sort((a, b) => py.len(key(b)) - py.len(key(a)));

/** What one tables object derives: Python's semantics, the validators, the lookups in their Python order. */
class Compiler {
  readonly py: Python;
  readonly specs: Specs;
  readonly profiles: Map<string, TextCompilerProfile>;
  readonly templates: Map<string, TextCompilerTemplate>;
  /** sorted(PROFILE_ALIASES.items(), key=lambda pair: -len(pair[0])) — stable, so dict order among equal lengths */
  readonly profileAliasesByLength: [string, string][];
  /** sorted(ORGAN_ALIASES.items(), key=lambda pair: -len(pair[0])) */
  readonly organAliasesByLength: [string, string][];
  /** sorted(atlas_text.ALIASES.items(), key=lambda p: -len(p[0])) */
  readonly geometryAliasesByLength: [string, string][];
  constructor(readonly tables: TextCompilerTables) {
    this.py = new Python(tables.unicode);
    this.specs = new Specs(tables);
    this.profiles = new Map(tables.profiles.map((p) => [p.id, p]));
    this.templates = new Map(tables.templates.map((t) => [t.template_id, t]));
    this.profileAliasesByLength = byLengthDesc(this.py, tables.profile_aliases, ([alias]) => alias);
    this.organAliasesByLength = byLengthDesc(this.py, tables.organ_aliases, ([alias]) => alias);
    this.geometryAliasesByLength = byLengthDesc(this.py, tables.geometry_aliases, ([alias]) => alias);
  }
  /** get_template(root, id).metadata: a template the library lacks is the route's 404 (str(KeyError) quotes it) */
  template(templateId: string): TextCompilerTemplate {
    const entry = this.templates.get(templateId);
    if (!entry) throw new TextCompilerRequestError(404, `'Template ${templateId} is unavailable'`);
    return entry;
  }
  profile(profileId: string): TextCompilerProfile {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Unknown disease profile ${profileId}.`);
    return profile;
  }
}
const compilers = new WeakMap<TextCompilerTables, Compiler>();
const compilerFor = (tables: TextCompilerTables): Compiler => {
  let compiler = compilers.get(tables);
  if (!compiler) { compiler = new Compiler(tables); compilers.set(tables, compiler); }
  return compiler;
};

/** One request: the compiler and where the template vertices come from (each template measured from its reference). */
class Session {
  private readonly vertices = new Map<string, Promise<Float64Array>>();
  constructor(readonly c: Compiler, private readonly references: (templateId: string) => Promise<AtlasGeneration>) {}
  rest(templateId: string): Promise<Float64Array> {
    let promise = this.vertices.get(templateId);
    if (!promise) { promise = this.load(templateId); this.vertices.set(templateId, promise); }
    return promise;
  }
  private async load(templateId: string): Promise<Float64Array> {
    const entry = this.c.template(templateId);
    const reference = await this.references(templateId);
    const known = restCache.get(reference);
    if (known) return known;
    if (reference?.spec?.template_id !== templateId) throw new Error(`The reference handed over for ${templateId} is another template.`);
    const bound = reference.spec.template_sha256;
    if (typeof bound === "string" && bound !== entry.artifact_sha256)
      throw new Error(`The reference of ${templateId} is not the ${this.c.tables.template_root} surface the API measures.`);
    const organ = reference.scene?.organs?.[0] as { rest_positions?: ArrayLike<number> } | undefined;
    const raw = organ?.rest_positions;
    if (!raw || raw.length !== entry.vertex_count * 3) throw new Error(`The reference of ${templateId} carries no rest surface of its ${entry.vertex_count} vertices.`);
    const rest = Float64Array.from(raw);
    restCache.set(reference, rest);
    return rest;
  }
}
const restCache = new WeakMap<object, Float64Array>();

// ---------------------------------------------------------------------------------------------- atlas_text
const GEOMETRY_AXES = ["width", "height", "depth", "wide", "tall", "deep"];   // list(AXES)
const AXIS_INDEX: Record<string, number> = { width: 0, height: 1, depth: 2, wide: 0, tall: 1, deep: 2 };
const GEOMETRY_DIRECTIONS: Record<string, [number, number]> = { wider: [0, 1], narrower: [0, -1], taller: [1, 1], shorter: [1, -1], deeper: [2, 1], flatter: [2, -1] };
const zeroControls = (): Record<string, number> => Object.fromEntries(CONTROLS.map((k) => [k, 0.0]));

/** viscera_core.atlas_text.compile_text: reference selection and bounded shape edits, dimensions solved on the mesh. */
async function compileGeometry(session: Session, text: string, spec: GeometryDump): Promise<Result> {
  const { c } = session, py = c.py;
  const unsupported = (message: string): Result => ({ status: "unsupported", message, policy_version: GEOMETRY_TEXT_POLICY });
  if (!py.strip(text) || py.len(text) > 4000) return unsupported("Enter an organ and a supported shape or dimension edit.");
  let remaining = py.rstripDotBang(py.strip(py.lower(text)));
  if (py.test(String.raw`\b(not|no|without|except|avoid|unless|never|tumor|tumour|disease|resect|remove|cut)\b`, remaining))
    return unsupported("This compiler supports reference selection and bounded shape edits; this request contains an unsupported constraint.");
  const library = c.tables.templates;
  const current = library.find((t) => t.template_id === spec.template_id);
  if (!current) return unsupported("The current reference is unavailable.");
  const mentions: string[] = [];
  for (const [alias, organ] of c.geometryAliasesByLength) {
    const pattern = String.raw`\b` + pyEscape(alias) + String.raw`\b`;
    if (py.test(pattern, remaining)) { mentions.push(organ); remaining = py.sub(pattern, " ", remaining); }
  }
  if (new Set(mentions).size > 1) return unsupported("Select one organ at a time; multi-organ assembly is not implemented.");
  const organ = mentions[0] ?? current.organ;
  const selectors = new Map<"sex_label" | "laterality", string>();
  for (const [word, key] of [["female", "sex_label"], ["male", "sex_label"], ["left", "laterality"], ["right", "laterality"]] as const) {
    const pattern = String.raw`\b` + word + String.raw`\b`;
    if (py.test(pattern, remaining)) {
      if (selectors.has(key)) return unsupported("Choose one sex label and one side.");
      selectors.set(key, word);
      remaining = py.sub(pattern, " ", remaining);
    }
  }
  const candidates = library.filter((t) => t.organ === organ && [...selectors].every(([k, v]) => t[k] === v));
  if (!candidates.length) return unsupported("That organ/reference combination is not in the licensed library.");
  const chosen = candidates.find((t) => t.template_id === spec.template_id)
    ?? [...candidates].sort((a, b) => (a.template_id < b.template_id ? -1 : a.template_id > b.template_id ? 1 : 0))[0]!;
  const switched = chosen.template_id !== spec.template_id;
  let controls: Record<string, number> = switched ? zeroControls() : { ...spec.controls };
  let appearance: Appearance = spec.appearance;
  const resetPattern = String.raw`\b(reset|original|reference shape|undeformed)\b`;
  const reset = py.test(resetPattern, remaining);
  if (reset) { controls = zeroControls(); remaining = py.sub(resetPattern, " ", remaining); }
  // `original = extents(controls)` is taken here, before any edit; it is measured once a relative target needs it
  const originalControls = { ...controls };
  const targets = new Map<number, { value: number } | { factor: number }>();
  const changes: string[] = [];
  const directControls = new Set<string>();
  const appearanceRequests = new Set<string>();
  try {
    const absolute = (m: PyMatch): string => {
      const axis = AXIS_INDEX[m.group("axis")!]!;
      const value = py.float(m.group("number")!) * (m.group("unit") === "cm" ? 10 : 1);
      if (targets.has(axis)) throw new PyValueError("Each dimension may be requested only once.");
      if (!Number.isFinite(value) || value <= 0) throw new PyValueError("Dimensions must be positive.");
      targets.set(axis, { value });
      changes.push(`${GEOMETRY_AXES[axis]} ${pyFormatG(value)} mm`);
      return " ";
    };
    remaining = py.sub(String.raw`\b(?P<axis>width|height|depth)\s*(?:of|to|=|:)?\s*(?P<number>\d+(?:\.\d+)?)\s*(?P<unit>mm|cm)\b`, absolute, remaining);
    remaining = py.sub(String.raw`\b(?P<number>\d+(?:\.\d+)?)\s*(?P<unit>mm|cm)\s*(?P<axis>wide|tall|deep)\b`, absolute, remaining);
    remaining = py.sub(String.raw`\b(?:(?P<percent>\d+(?:\.\d+)?)\s*%\s*|(?P<qualifier>slightly|a little)\s+)?(?P<direction>wider|narrower|taller|shorter|deeper|flatter)\b`, (m) => {
      const [axis, sign] = GEOMETRY_DIRECTIONS[m.group("direction")!]!;
      if (targets.has(axis)) throw new PyValueError("Each dimension may be requested only once.");
      const percent = m.group("percent"), qualifier = m.group("qualifier");
      const fraction = percent ? py.float(percent) / 100 : qualifier === "slightly" || qualifier === "a little" ? 0.03 : 0.05;
      if (fraction <= 0 || fraction >= 1) throw new PyValueError("Relative dimensions must change by more than zero and less than 100%.");
      targets.set(axis, { factor: 1 + sign * fraction });   // original[axis] * (1 + sign * fraction)
      changes.push(`${pyFormatG(fraction * 100)}% ${m.group("direction")!}`);
      return " ";
    }, remaining);
    for (const [word, key] of [["bent", "bend"], ["twisted", "twist"], ["tapered", "taper"], ["asymmetric", "asymmetry"]] as const) {
      const pattern = String.raw`\b(more|less)\s+` + word + String.raw`\b`;
      const m = py.search(pattern, remaining);
      if (m) {
        const old = controls[key]!;
        controls[key] = m.group(1) === "less" ? npSign(old) * Math.max(0, Math.abs(old) - 0.2) : (old ? npSign(old) : 1.0) * (Math.abs(old) + 0.2);
        changes.push(m.group(0)!);
        remaining = py.sub(pattern, " ", remaining, 1);
      }
    }
    for (const key of CONTROLS) {
      const m = py.search(String.raw`\b` + key + String.raw`\s*(?:to|=|:)?\s*(-?\d+(?:\.\d+)?)\b`, remaining);
      if (m) {
        directControls.add(key);
        controls[key] = py.float(m.group(1)!);
        changes.push(`${key} ${pyFormatG(controls[key]!)}`);
        remaining = remaining.slice(0, m.start) + " " + remaining.slice(m.end);
      }
    }
    for (const mode of ["tissue", "source", "clay"] as const) {
      const pattern = String.raw`\b` + mode + String.raw`(?:\s+appearance)?\b`;
      if (py.test(pattern, remaining)) {
        appearanceRequests.add(mode); appearance = mode; changes.push(mode + " appearance");
        remaining = py.sub(pattern, " ", remaining);
      }
    }
    remaining = py.sub(String.raw`\b(make|the|a|an|please|generate|create|show|use|select|organ|reference|shape|and|with|set|to|be|it)\b`, " ", remaining);
    remaining = py.strip(py.sub(String.raw`[\s,;]+`, " ", remaining));
    if (remaining) return unsupported("Unsupported wording: " + remaining + ". Use e.g. “liver 5% wider”, “width 200 mm” or “twist 0.2”.");
    if (!(mentions.length || selectors.size || reset || changes.length)) return unsupported("No supported organ or shape edit was found.");
    if (Object.values(controls).some((v) => !(-1 <= v && v <= 1))) throw new PyValueError("The request exceeds the bounded shape-control range.");
    if (appearanceRequests.size > 1) return unsupported("Choose one appearance mode per request.");
    if ([...targets.keys()].some((axis) => directControls.has(CONTROLS[axis]!))) return unsupported("Specify a dimension target or its scale control, not both.");
    // every answer from here on measures the chosen template: the reference is needed only now
    const rest = await session.rest(chosen.template_id);
    const extents = (values: Record<string, number>) => deformedExtents(rest, values, chosen.control_limits, chosen.normalization_mm);
    const original = [...targets.values()].some((t) => "factor" in t) ? extents(originalControls) : null;
    const resolved = new Map<number, number>([...targets].map(([axis, t]) => [axis, "value" in t ? t.value : original![axis]! * t.factor]));
    if (resolved.size) {
      const axes = [...resolved.keys()].sort((a, b) => a - b);
      const keys = axes.map((i) => CONTROLS[i]!);
      const wanted = axes.map((i) => resolved.get(i)!);
      const residual = (values: ArrayLike<number>): Float64Array => {
        const trial = { ...controls };
        keys.forEach((k, j) => { trial[k] = values[j]!; });
        const e = extents(trial);
        return Float64Array.from(axes, (axis, j) => (e[axis]! - wanted[j]!) / wanted[j]!);
      };
      let solved: ReturnType<typeof leastSquaresTrf>;
      try {
        solved = leastSquaresTrf(residual, keys.map((k) => controls[k]!), { lower: -1, upper: 1, xtol: 1e-11, ftol: 1e-11, gtol: 1e-11, maxNfev: 80 });
      } catch (error) { throw new PyValueError(error instanceof Error ? error.message : String(error)); }
      if (!solved.success || Math.max(...Array.from(residual(solved.x), Math.abs)) > 1e-4)
        return unsupported("Requested dimensions cannot be reached within this reference’s conservative control bounds. No edit was applied.");
      keys.forEach((k, j) => { controls[k] = solved.x[j]!; });
    }
    const output = c.specs.geometry({ template_id: chosen.template_id, seed: spec.seed, controls, appearance });
    const actual = extents(output.controls);
    let worst: number | null = null;
    for (const [axis, value] of resolved) { const error = Math.abs(actual[axis]! - value) / value; if (worst === null || error > worst) worst = error; }
    return {
      status: "accepted",
      message: "Prepared " + chosen.template_id + (changes.length ? " · " + changes.join(", ") : "") + ". Numeric dimensions are checked against the actual deformed mesh.",
      spec: dumpSpec(output, "geometry"),
      policy_version: GEOMETRY_TEXT_POLICY,
      interpretation: "Bounded design edits; qualitative “slightly” means 3%, unqualified relative edits 5%.",
      measured_extent_mm: actual,
      // a dict keyed str(axis) in request order; JSON readers (JSON.parse too) order such integer-like keys numerically
      requested_extent_mm: Object.fromEntries([...resolved].map(([axis, value]) => [String(axis), value])),
      max_dimension_relative_error: worst ?? 0.0,
    };
  } catch (error) {
    if (error instanceof PyValueError) return unsupported(error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------- atlas_material_text
const SURFACE_LABELS: [string, string][] = [["tint", "tint"], ["pigment contrast", "pigment_contrast"], ["mottle scale", "mottle_scale_mm"], ["wetness", "wetness"], ["fine detail", "fine_detail"], ["structure strength", "structure_strength"], ["texture seed", "seed"], ["surface seed", "seed"]];
const SURFACE_RELATIVE: [string, string, number][] = [["wetter", "wetness", 0.15], ["drier", "wetness", -0.15], ["more mottled", "pigment_contrast", 0.15], ["less mottled", "pigment_contrast", -0.15], ["warmer", "tint", 0.2], ["cooler", "tint", -0.2], ["more fine detail", "fine_detail", 0.15], ["less fine detail", "fine_detail", -0.15]];

/** viscera_core.atlas_material_text.compile_text: the surface grammar around the unchanged shape compiler. */
async function compileSurface(session: Session, text: string, spec: SurfaceDump): Promise<Result> {
  const { c } = session, py = c.py;
  const refused = (message: string): Result => ({ status: "unsupported", message, policy_version: SURFACE_TEXT_POLICY });
  let remaining = py.rstripDotBang(py.strip(py.lower(text)));
  const changes = new Map<string, number>();
  let preset: string | null = null;
  try {
    if (py.test(String.raw`\b(not|no|without|except|avoid|unless|never|tumou?r|disease|resect|remove|cut)\b`, remaining)) return await compileGeometry(session, text, geometryOf(spec));
    const assign = (key: string, value: number) => {
      if (changes.has(key)) throw new PyValueError(`Specify ${key.replaceAll("_", " ")} only once per request.`);
      changes.set(key, value);
    };
    remaining = py.sub(String.raw`\b(balanced|soft|rich|moist)\s+(?:surface|texture|material)(?:\s+preset)?\b`, (m) => {
      if (preset !== null) throw new PyValueError("Choose one surface preset per request.");
      preset = m.group(1);
      return " ";
    }, remaining);
    for (const [label, key] of SURFACE_LABELS) {
      let pattern = String.raw`\b` + label + String.raw`\s*(?:to|=|:)?\s*(-?\d+(?:\.\d+)?)\b`;
      if (key === "mottle_scale_mm") pattern += String.raw`(?:\s*mm\b)?`;
      remaining = py.sub(pattern, (m) => {
        const raw = m.group(1)!;
        if (key === "seed" && raw.includes(".")) throw new PyValueError("Texture seed must be an integer.");
        assign(key, key === "seed" ? py.int(raw) : py.float(raw));
        return " ";
      }, remaining);
    }
    const relativeEdits = new Map<string, number>();
    for (const [phrase, key, delta] of SURFACE_RELATIVE) {
      const pattern = String.raw`\b` + phrase + String.raw`\b`;
      const count = py.findall(pattern, remaining).length;
      if (count) {
        if (count > 1 || relativeEdits.has(key) || changes.has(key)) throw new PyValueError(`Conflicting or repeated ${key.replaceAll("_", " ")} edits.`);
        relativeEdits.set(key, delta);
        remaining = py.sub(pattern, " ", remaining);
      }
    }
    const materialEdit = Boolean(preset || changes.size || relativeEdits.size);
    let result: Result;
    if (!materialEdit) result = await compileGeometry(session, text, geometryOf(spec));
    else {
      const residual = py.strip(py.sub(String.raw`\b(make|the|a|an|please|generate|create|show|use|select|organ|reference|shape|and|with|set|to|be|it)\b|[\s,;]+`, " ", remaining));
      result = residual ? await compileGeometry(session, remaining, geometryOf(spec))
        : { status: "accepted", spec: dumpSpec(geometryOf(spec), "geometry"), message: "Prepared surface-only edit; shape is unchanged.", policy_version: SURFACE_TEXT_POLICY };
    }
    if (result.status !== "accepted") return result;
    const target = c.specs.surface(result.spec);
    const organ = c.template(target.template_id).organ;
    let material: MaterialDump | null = spec.material ?? null;
    if (materialEdit) {
      if (material === null || material.organ !== organ || preset) material = c.specs.makeRecipe(organ, preset || "balanced", material ? material.seed : 42);
      const values = clone(material) as unknown as Dict;   // material.model_dump()
      for (const [key, value] of changes) values[key] = value;
      for (const [key, delta] of relativeEdits) values[key] = (values[key] as number) + delta;
      material = c.specs.material(values);
      if (target.appearance !== "tissue" && py.test(String.raw`\b(source|clay)\b`, py.lower(text))) return refused("Choose an authored surface or source/clay appearance, not both.");
      target.appearance = "tissue";
    } else if (target.appearance !== "tissue") material = null;
    else if (material !== null && material.organ !== organ) material = c.specs.makeRecipe(organ, material.preset, material.seed);
    if (material) target.material = material; else delete target.material;
    target.realized_id = null;
    target.template_sha256 = null;
    result.spec = dumpSpec(target, "surface");
    if (materialEdit || spec.material) {
      result.policy_version = SURFACE_TEXT_POLICY;
      result.material_interpretation = "Authored appearance controls; no tissue measurement or disease inference.";
      if (materialEdit) result.message += " Surface recipe prepared.";
    }
    return result;
  } catch (error) {
    if (error instanceof PyValueError) return refused(error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------- atlas_disease_text_v2
/** viscera_core.atlas_disease_text_v2.compile_text: explicit profiles, baseline and recipe controls, composed
 *  atomically with the surface and shape grammar. Only its acceptance reaches the route's answer. */
async function compileDiseaseText(session: Session, text: string, spec: V2Dump): Promise<Result> {
  const { c } = session, py = c.py;
  const refused = (message: string): Result => ({ status: "unsupported", message, policy_version: DISEASE_TEXT_POLICY });
  let remaining = py.rstripDotBang(py.strip(py.lower(text)));
  const selected: string[] = [];
  for (const [key, aliases] of c.tables.disease_text_aliases) {
    const alternatives = byLengthDesc(py, [...aliases, key], (alias) => alias);
    const pattern = String.raw`\b(?:` + alternatives.map(pyEscape).join("|") + String.raw`)\b`;
    if (py.test(pattern, remaining)) { selected.push(key); remaining = py.sub(pattern, " ", remaining); }
  }
  const healthyPattern = String.raw`\b(?:healthy|baseline|clear disease)\b`;
  const healthy = py.test(healthyPattern, remaining);
  const changes = new Map<string, number>();
  for (const name of ["severity", "size", "spread", "irregularity", "contrast", "count", "disease seed"]) {
    const pattern = String.raw`\b` + name + String.raw`\s*(?:to|=|:)?\s*(-?\d+(?:\.\d+)?)\b`;
    const matches = py.findall(pattern, remaining);
    if (matches.length > 1) return refused(`Specify ${name} once.`);
    if (matches.length) {
      const raw = matches[0]!, integral = name === "count" || name === "disease seed";
      if (integral && raw.includes(".")) return refused(`${name} must be an integer.`);
      changes.set(name === "disease seed" ? "seed" : name, integral ? py.int(raw) : py.float(raw));
      remaining = py.sub(pattern, " ", remaining);
    }
  }
  const diseaseIntent = Boolean(selected.length || healthy || changes.size);
  if (!diseaseIntent) {
    const result = await compileSurface(session, text, surfaceOf(c.specs, spec));
    if (result.status === "accepted") {
      const target = c.specs.v2({ ...(result.spec as Dict), renderer_version: "disease-v2" });
      if (spec.disease) {
        if (c.template(target.template_id).organ !== c.profile(spec.disease.profile_id).organ) return refused("Clear the disease or choose a compatible disease when changing organs.");
        target.disease = spec.disease;
      }
      result.spec = dumpSpec(target, "v2");
    }
    return result;
  }
  if (selected.length > 1 || (healthy && selected.length)) return refused("Choose one disease profile or baseline per request.");
  if (py.test(String.raw`\b(not|no|without|except|avoid|unless|never|remove|resect|cut|stage|grade|stiffness|kpa|mm|cm)\b`, remaining))
    return refused("This grammar supports explicit morphology controls, not negation, clinical stages, dimensions or tissue mechanics.");
  if (selected.length && !c.profile(selected[0]!).supported) return refused(c.profile(selected[0]!).unavailable_reason);
  let target: V2Dump = clone(spec);
  try {
    if (selected.length) {
      const profile = c.profile(selected[0]!);
      const currentOrgan = c.template(target.template_id).organ;
      if (currentOrgan !== profile.organ) {
        const organ = c.tables.catalog_organs.find((o) => o.id === profile.organ);
        if (!organ) return refused("This anatomy library has no matching organ reference.");
        target.template_id = organ.templates[0]!;
        target.controls = Object.fromEntries(Object.keys(target.controls).map((k) => [k, 0.0]));
        if (target.material) target.material = c.specs.makeRecipe(profile.organ, "balanced", target.material.seed);
      }
      const existing = spec.disease && spec.disease.profile_id === selected[0] ? spec.disease : c.specs.diseaseDefaults(selected[0]!, spec.seed);
      target.disease = c.specs.disease({ ...existing, ...Object.fromEntries(changes) });
    } else if (healthy) {
      if (changes.size) return refused("Baseline has no active disease controls.");
      delete target.disease;
      remaining = py.sub(healthyPattern, " ", remaining);
    } else if (spec.disease) target.disease = c.specs.disease({ ...spec.disease, ...Object.fromEntries(changes) });
    else return refused("Choose a disease profile before setting disease controls.");
    const residual = py.strip(py.sub(String.raw`\b(make|the|a|an|please|generate|create|show|use|select|organ|reference|shape|and|with|set|to|be|it|disease)\b|[\s,;]+`, " ", remaining));
    if (residual) {
      const result = await compileSurface(session, remaining, surfaceOf(c.specs, target));
      if (result.status !== "accepted") return result;
      const revised = c.specs.v2({ ...(result.spec as Dict), renderer_version: "disease-v2" });
      if (target.disease && c.template(revised.template_id).organ !== c.profile(target.disease.profile_id).organ) return refused("Disease and requested organ conflict.");
      if (target.disease) revised.disease = target.disease;
      target = revised;
    }
    target.template_sha256 = null;
    target.realized_id = null;
    return { status: "accepted", spec: dumpSpec(target, "v2"), message: "Prepared disease morphology design. Strength is an engineering control, not a clinical stage.", policy_version: DISEASE_TEXT_POLICY };
  } catch (error) {
    if (error instanceof PyValueError) return refused(error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------- atlas_semantic
const operation = (op: string, field?: string | null, value?: number | string | null): Op => {
  const item: Op = { op };
  if (field !== undefined && field !== null) item.field = field;
  if (value !== undefined && value !== null) item.value = value;
  return item;
};
/** dict equality of two operations (Python's == on numbers: 3 == 3.0, -0.0 == 0.0) */
const sameOp = (a: Op, b: Op) => a.op === b.op && ("field" in a) === ("field" in b) && a.field === b.field && ("value" in a) === ("value" in b) && a.value === b.value;
/** The one int-valued operation: disease_set count (parse_semantic stores int(value)); every other number is a float. */
const intValued = (item: Op) => item.op === "disease_set" && item.field === "count";
const makePlan = (operations: Op[] = [], status = "accepted", message = "Prepared bounded anatomy appearance edits."): Plan =>
  ({ schema_version: SCHEMA_VERSION, status, operations, message, interpretation: INTERPRETATION });
const refuse = (message: string, status = "unsupported"): Plan => makePlan([], status, message);
const withPolicy = (plan: Plan): Result => ({ ...plan, policy_version: SEMANTIC_POLICY_VERSION });

/** json.dumps of one operation: sorted keys (field, op, value), Python's separators, float repr */
const opJson = (item: Op, compact: boolean): string => {
  const [comma, colon] = compact ? [",", ":"] : [", ", ": "];
  const parts: string[] = [];
  if (item.field !== undefined) parts.push(`"field"${colon}${pyJsonString(item.field)}`);
  parts.push(`"op"${colon}${pyJsonString(item.op)}`);
  if (item.value !== undefined) parts.push(`"value"${colon}${typeof item.value === "string" ? pyJsonString(item.value) : intValued(item) ? String(item.value + 0) : pyRepr(item.value)}`);
  return `{${parts.join(comma)}}`;
};
/** plan_fingerprint: sha256 of the canonical JSON of schema, status and the operations sorted by their json.dumps */
export function planFingerprint(plan: Pick<Plan, "schema_version" | "status" | "operations">): string {
  const sorted = plan.operations.map((item) => [opJson(item, false), item] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(`{"operations":[${sorted.map(([, item]) => opJson(item, true)).join(",")}],"schema_version":${pyJsonString(plan.schema_version)},"status":${pyJsonString(plan.status)}}`);
}

function contextFromSpec(spec: V2Dump, organ?: string): Context {
  return {
    organ: organ ?? ORGANS.find((o) => spec.template_id.includes(o)) ?? null,
    disease: spec.disease ? clone(spec.disease) : null,
    controls: { ...spec.controls },
    material: spec.material ? clone(spec.material) : null,
    appearance: spec.appearance ?? "tissue",
    renderer_version: spec.renderer_version ?? "legacy",
  };
}
const normalise = (py: Python, text: string) => py.strip(py.sub(String.raw`\s+`, " ", py.lower(text).replaceAll("’", "'").replaceAll("−", "-").replaceAll("–", "-")));

const PRESERVE_FIELD = "shape control values|shape controls|lesion size|region size|disease|lesions?|tumou?rs?|pathology|shape|geometry|dimensions?|width|height|depth|material|texture|surface|colou?r|appearance|severity|contrast|size|spread|irregularity|count|wetness|tint|bend|twist|taper|asymmetry";
const PRESERVE_PATTERNS = [
  String.raw`\b(?:do not|don't|never)\s+(?:change|alter|modify|touch|remove|clear|reduce|increase)\s+(?:the\s+)?(${PRESERVE_FIELD})(?:\s+(?:at all|in any way))?\b`,
  String.raw`\bwithout\s+(?:changing|altering|modifying|removing|clearing)\s+(?:the\s+)?(${PRESERVE_FIELD})\b`,
  String.raw`\b(?:keep|leave)\s+(?:the\s+)?(${PRESERVE_FIELD})\s+(?:unchanged|the same|as is|intact|alone)\b`,
  String.raw`\bpreserv(?:e|ing)\s+(?:(?:the|its)\s+)?(${PRESERVE_FIELD})\b`,
];
const PRESERVE_NAMES: Record<string, string> = { "shape controls": "shape_controls", "shape control values": "shape_controls", geometry: "shape", dimension: "dimensions", dimensions: "dimensions", size: "dimensions", "lesion size": "size", "region size": "size", lesion: "disease", lesions: "disease", tumor: "disease", tumors: "disease", tumour: "disease", tumours: "disease", pathology: "disease", texture: "material", surface: "material", color: "material", colour: "material" };
const NEGATED_DIRECTIONS: Record<string, string> = { wider: "width", narrower: "width", taller: "height", shorter: "height", deeper: "depth", flatter: "depth", healthier: "disease", sicker: "disease", wetter: "wetness", drier: "wetness" };
const UNSUPPORTED = String.raw`\b(?:resect\w*|resection|excise\w*|excision|cut\w*|remove|amputat\w*|anastom\w*|sutur\w*|transplant\w*|bleed\w*|haemorrhag\w*|hemorrhag\w*|perfus\w*|blood flow|portal pressure|blood pressure|vascular|arter(?:y|ies|ial)|vein\w*|vessel\w*|stiffness|elastic(?:ity|modulus)?|kpa|young's|clinical stage|stage\s*\d|grade\s*\d|diagnos\w*|prognos\w*|cur(?:e|ed|ing)|metastasiz\w*|resectable|operable|surgically safe|histolog\w*|chemotherap\w*|malignant transformation|benign transformation)\b`;

/** _extract_preserves: explicit "do not change X" constraints and negated directions, as preserve operations */
function extractPreserves(py: Python, text: string): [string, Op[]] {
  const preserves: Op[] = [];
  const add = (item: Op) => { if (!preserves.some((p) => sameOp(p, item))) preserves.push(item); return " "; };
  for (const pattern of PRESERVE_PATTERNS) text = py.sub(pattern, (m) => add(operation("preserve", PRESERVE_NAMES[m.group(1)!] ?? m.group(1)!)), text);
  const pattern = String.raw`\b(?:do not|don't|never)\s+(?:make\s+)?(?:it\s+|the organ\s+)?(` + Object.keys(NEGATED_DIRECTIONS).join("|") + String.raw`)\b`;
  text = py.sub(pattern, (m) => add(operation("preserve", NEGATED_DIRECTIONS[m.group(1)!]!)), text);
  return [text, preserves];
}

/** source_guard: limits shared by every path */
function sourceGuard(c: Compiler, text: string): Plan | null {
  const py = c.py;
  if (typeof text !== "string" || !py.strip(text) || py.len(text) > MAX_TEXT_LENGTH) return refuse("Enter one anatomy edit of at most 4000 characters.");
  let [remaining] = extractPreserves(py, normalise(py, text));
  remaining = py.sub(String.raw`\bremove\s+(?:the\s+)?(?:disease|pathology)(?:\s+appearance)?\b`, "clear disease", remaining);
  if (py.test(String.raw`\b(?:duplicate|clon(?:e|ing)|split|join|merge|perforat\w*|hole|holes|hollow|interior|internal|segmentectom\w*|lobectom\w*|child[- ]pugh|meld|tnm|bclc|metavir|fibroscan|diagnostic|biopsy|histopatholog\w*|chemotherap\w*)\b`, remaining))
    return refuse("This request requires an unsupported anatomical or clinical operation. No edit was applied.");
  if (py.test(UNSUPPORTED, remaining)) return refuse("This request needs internal anatomy, topology, clinical inference or mechanics that this surface model does not implement. No edit was applied.");
  if (py.test(String.raw`\b(?:lesion|tumou?r|cyst|nodule|mass)(?:\s+(?:size|diameter|radius))?\s*(?:of|to|=|:)?\s*` + NUMBER + String.raw`\s*(?:mm|cm)\b|\b` + NUMBER + String.raw`\s*(?:mm|cm)\s*(?:lesion|tumou?r|cyst|nodule|mass)\b`, remaining))
    return refuse("A physical lesion diameter is not implemented; region size is a normalized authored support control. Specify a relative lesion-size edit or an organ dimension.");
  if (py.test(String.raw`\b(?:not|no|without|except|unless|avoid|never|don't|do not)\b`, remaining))
    return refuse("This negative or conditional instruction is ambiguous. State the edit and explicitly name fields to preserve.", "clarify");
  if (py.test(String.raw`\b(?:normal(?:ize|ise)?|healthy|healthier)\b`, remaining) && py.test(String.raw`\b(?:sicker|worse|more diseased|unhealthy)\b`, remaining))
    return refuse("Healthier and more diseased conflict; choose one direction.");
  return null;
}
const aliasPattern = (alias: string) => String.raw`(?<!\w)` + pyEscape(alias) + String.raw`(?!\w)`;

/** request_guard: the guards that also precede an otherwise successful compiler */
function requestGuard(c: Compiler, text: string, context: Context): Plan | null {
  const py = c.py;
  const refused = sourceGuard(c, text);
  if (refused) return refused;
  const source = normalise(py, text);
  if (py.test(String.raw`\b(?:tumou?rs?|cysts?)\b`, source)) {
    let chosen: string | null = context.disease?.profile_id ?? null;
    const selected = new Set<string>();
    for (const [alias, profileId] of c.tables.profile_aliases) if (py.test(aliasPattern(alias), source)) selected.add(profileId);
    if (selected.size === 1) chosen = [...selected][0]!;
    const profile = chosen === null ? undefined : c.profiles.get(chosen);
    const description = py.lower((["id", "label", "pattern", "mechanism"] as const).map((key) => String(profile?.[key] ?? "")).join(" "));
    if (py.test(String.raw`\bcysts?\b`, source) && !description.includes("cyst"))
      return refuse("The selected appearance has no cystic region. Choose a cystic profile before editing cyst size.", "clarify");
    if (py.test(String.raw`\btumou?rs?\b`, source) && !py.test("mass|carcinoma|cancer|metast|tumor|tumour|meningioma|glioblastoma|neuroendocrine", description))
      return refuse("The selected appearance has no tumor region. Choose a matching mass profile before editing tumor size.", "clarify");
  }
  if (context.disease && py.test(String.raw`\b(?:width|height|depth|wide|tall|deep)\b`, source) && py.test(String.raw`\b(?:mm|cm)\b`, source)) {
    if (!py.test(String.raw`\b(?:clear disease|clear pathology|healthy|baseline|normalise|normalize|disease-free)\b`, source))
      return refuse("Absolute dimensions of the final diseased surface cannot currently be solved. Clear the disease explicitly or request a relative dimension edit.", "clarify");
  }
  return null;
}

/** _targets: the fields an edit touches, for the preservation check */
function targetsOf(item: Op): Set<string> {
  const { op } = item, field = String(item.field);
  if (op === "disease_clear") return new Set(["disease", "shape", "dimensions", ...DIMENSIONS, ...DISEASE_FIELDS, "profile_id"]);
  if (op.startsWith("disease_")) return new Set(["disease", field, ...(field !== "contrast" ? ["shape", "dimensions", ...DIMENSIONS] : [])]);
  if (op.startsWith("shape_")) return new Set(["shape", "shape_controls", "dimensions", field, CONTROLS[DIMENSIONS.indexOf(field)]!]);
  if (op === "control_set") return new Set(["shape", "shape_controls", "dimensions", field, ...DIMENSIONS]);
  if (op.startsWith("material_")) return new Set(["material", field]);
  return new Set([field]);
}
const PRESERVABLE = new Set(["shape", "shape_controls", "dimensions", "disease", "material", "appearance", ...CONTROLS, ...DIMENSIONS, ...DISEASE_FIELDS, ...MATERIAL_CONTROLS]);

/** validate_plan: a normalized inert plan, or a refusal with zero operations */
function validatePlan(c: Compiler, plan: Plan, context: Context, text: string | null): Plan {
  const py = c.py;
  if (plan.schema_version !== SCHEMA_VERSION || !["accepted", "clarify", "unsupported"].includes(plan.status)) return refuse("Unsupported wording plan schema or status.");
  if (plan.interpretation !== INTERPRETATION) return refuse("The wording plan must identify its authored visual scope.");
  if (typeof plan.message !== "string" || py.len(plan.message) > 1000) return refuse("Invalid wording explanation.");
  const operations = plan.operations;
  if (!Array.isArray(operations) || operations.length > 24) return refuse("A wording plan may contain at most 24 edits.");
  if (plan.status !== "accepted") return makePlan([], plan.status, plan.message);
  if (text !== null) { const refusal = requestGuard(c, text, context); if (refusal) return refusal; }
  const normalised: Op[] = [];
  const keys = new Set<string>(), preserved = new Set<string>();
  const active = Boolean(context.disease);
  const profileSelected = operations.some((x) => x.op === "disease_set" && x.field === "profile_id");
  try {
    for (const item of operations) {
      const { op, field, value } = item;
      let key: string;
      if (op === "disease_clear") {
        if (Object.keys(item).length !== 1) throw new PyValueError("Disease clear has no parameters.");
        key = "disease.clear";
      } else if (op === "preserve") {
        if (!(Object.keys(item).length === 2 && field !== undefined) || !PRESERVABLE.has(field)) throw new PyValueError("Unknown preservation constraint.");
        preserved.add(field);
        key = "preserve." + field;
      } else if (op === "appearance_set") {
        if (field !== "appearance" || (value !== "tissue" && value !== "source" && value !== "clay")) throw new PyValueError("Unknown appearance mode.");
        key = "appearance";
      } else if (op === "disease_set" && field === "profile_id") {
        const profile = typeof value === "string" ? c.profiles.get(value) : undefined;
        if (!profile || !profile.supported) throw new PyValueError("This profile has no supported external surface representation.");
        if (context.organ !== profile.organ) throw new PyValueError("Choose the matching organ before selecting this disease profile.");
        // a legacy-renderer context would need the profile in the legacy table too; the public copy sends disease-v2 specs
        if ((context.renderer_version ?? "legacy") !== "disease-v2") return refuse("Select the expanded disease model before using this external profile.", "clarify");
        key = "disease.profile_id";
      } else {
        if (typeof value !== "number" || !Number.isFinite(value)) throw new PyValueError("Edit values must be finite numbers.");
        if (op === "disease_relative" || op === "disease_set") {
          if (field === undefined || !DISEASE_FIELDS.includes(field)) throw new PyValueError("Unknown disease control.");
          if (!active && !profileSelected) return refuse("Select an external disease profile before changing its appearance.", "clarify");
          if (op === "disease_relative" && (field === "count" || !(-0.95 <= value && value <= 0.95) || value === 0))
            throw new PyValueError("Disease relative edits must be a nonzero fraction in [-0.95,0.95]; count is an integer setting.");
          if (op === "disease_set" && !(field === "count" ? intValued(item) && Number.isInteger(value) && 1 <= value && value <= 8 : 0 <= value && value <= 1))
            throw new PyValueError("Disease controls are normalized to [0,1], with integer site count 1..8.");
          key = "disease." + field;
        } else if (op === "shape_relative" || op === "shape_absolute") {
          if (field === undefined || !DIMENSIONS.includes(field) || (op === "shape_relative" ? !(-0.95 <= value && value <= 0.95) || value === 0 : !(0 < value && value <= 2000)))
            throw new PyValueError("Dimensions require positive millimetres or a nonzero relative fraction in [-0.95,0.95].");
          key = "shape." + field;
        } else if (op === "control_set") {
          if (field === undefined || !CONTROLS.includes(field) || !(-1 <= value && value <= 1)) throw new PyValueError("Shape controls must be within [-1,1].");
          key = "shape." + (CONTROLS.slice(0, 3).includes(field) ? DIMENSIONS[CONTROLS.indexOf(field)]! : field);
        } else if (op === "material_relative" || op === "material_set") {
          if (field === undefined || !(field in MATERIAL_BOUNDS)) throw new PyValueError("Unknown material control.");
          const [lo, hi] = MATERIAL_BOUNDS[field]!;
          if ((op === "material_relative" && !(-0.5 <= value && value <= 0.5)) || (op === "material_set" && !(lo <= value && value <= hi)))
            throw new PyValueError("Material edit is outside the authored control bounds.");
          key = "material." + field;
        } else throw new PyValueError("Unknown wording operation.");
      }
      if (keys.has(key)) throw new PyValueError("A field was edited twice or in conflicting directions; no edit was applied.");
      keys.add(key);
      normalised.push({ ...item });
    }
    if (keys.has("disease.clear") && [...keys].some((k) => k.startsWith("disease.") && k !== "disease.clear")) throw new PyValueError("Baseline and disease edits cannot be requested together.");
    for (const item of normalised) if (item.op !== "preserve" && [...targetsOf(item)].some((t) => preserved.has(t))) throw new PyValueError("An edit conflicts with an explicit preservation constraint.");
    if (preserved.has("appearance") && context.appearance !== "tissue" && normalised.some((x) => x.op.startsWith("material_")))
      throw new PyValueError("Material edits require tissue appearance and cannot preserve the current appearance mode.");
    if (preserved.has("material") && context.material !== null && normalised.some((x) => x.op === "appearance_set" && x.value !== "tissue"))
      throw new PyValueError("Source/clay appearance clears the authored material and cannot preserve it.");
    if (normalised.some((x) => x.op.startsWith("material_")) && normalised.some((x) => x.op === "appearance_set" && x.value !== "tissue")) throw new PyValueError("Authored material edits require tissue appearance.");
    if (text !== null) {
      const [, required] = extractPreserves(py, normalise(py, text));
      if (required.some((item) => !normalised.some((n) => sameOp(n, item)))) throw new PyValueError("The model omitted an explicit preservation instruction.");
      if (!normalised.length && !(context.disease === null && py.test(String.raw`\b(?:healthier|less diseased|healthy|baseline|normalise|normalize|improved|improving|recovering|recovery|reduce|decrease|down|back|less severe overall)\b`, normalise(py, text))))
        throw new PyValueError("No supported edit or explicit preservation was produced.");
      const evidenceError = learnedDomainGuard(c, normalised, text, context);
      if (evidenceError) throw new PyValueError(evidenceError);
    }
  } catch (error) {
    if (error instanceof PyValueError || error instanceof PyTypeError) return refuse(error.message);
    throw error;
  }
  return makePlan(normalised, "accepted", plan.message);
}

/** Inert plan validation shared by offline parity checks; this never applies an edit or loads a model. */
export function validateSemanticPlan(tables: TextCompilerTables, plan: Plan, context: Context, text: string | null): Plan {
  return validatePlan(compilerFor(tables), plan, context, text);
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
/** min(items, key=...): the first item with the least key */
function firstMin<T>(items: T[], key: (item: T) => number): T {
  let best = items[0] as T, bestKey = key(best);
  for (const item of items.slice(1)) { const k = key(item); if (k < bestKey) { best = item; bestKey = k; } }
  return best;
}

function shapeComparative(py: Python, source: string, field: string): PyMatch | null {
  const directions: Record<string, string> = { width: "wider|broader|narrower", height: "taller|shorter", depth: "deeper|flatter" };
  return py.search(String.raw`(?<![\w.])(?:(?P<pct>` + NUMBER + String.raw`)\s*%\s*|(?P<qualifier>slightly|a little)\s+)?(?:` + directions[field]! + String.raw`|larger|bigger|smaller)\b`, source);
}

/** _learned_domain_guard: evidence guards; on the parser's own plans they hold, but they are part of the contract */
function learnedDomainGuard(c: Compiler, operations: Op[], text: string, context: Context): string | null {
  const py = c.py;
  const source = normalise(py, text);
  const [evidenceSource] = extractPreserves(py, source);
  const aliasesByLength = c.profileAliasesByLength.map(([alias]) => alias);
  let lexical = evidenceSource;
  for (const alias of aliasesByLength) lexical = py.sub(aliasPattern(alias), " ", lexical);
  let organText = lexical;
  const mentionedOrgans = new Set<string>();
  for (const [alias, organ] of c.organAliasesByLength) {
    const pattern = String.raw`\b` + pyEscape(alias) + String.raw`\b`;
    if (py.test(pattern, organText)) { mentionedOrgans.add(organ); organText = py.sub(pattern, " ", organText); }
  }
  if (mentionedOrgans.size && !(mentionedOrgans.size === 1 && context.organ !== null && mentionedOrgans.has(context.organ))) return "The requested organ differs from the current anatomy; select it first.";
  const domains: [string, string][] = [
    ["disease", "health|sick|diseas|patholog|sever|morpholog|lesion|tumou?r|cyst|nodul|scar|swoll|swelling|normal|baseline|contrast|spread|irregular|size|sites|count|profile|region|improv|recover|worse|better"],
    ["material", "wet|drier|dry|moist|sheen|gloss|matte|mottl|pigment|tint|warm|cool|redder|detail|grain|structure strength|mottle scale|material|texture"],
    ["shape", "width|wide|narrow|height|tall|short|depth|deep|flat|broad|larg|small|big|bend|twist|taper|asymmetr|scale_[xyz]|dimension"],
    ["appearance", String.raw`\b(?:tissue|source|clay)\b`],
  ];
  const represented = new Set<string>(operations.filter((x) => x.op !== "preserve").map((x) => (x.op.startsWith("disease_") ? "disease" : x.op.startsWith("material_") ? "material" : x.op.startsWith("shape_") || x.op === "control_set" ? "shape" : "appearance")));
  if (!context.disease) represented.add("disease");
  let clauseText = evidenceSource;
  for (const alias of aliasesByLength) clauseText = py.sub(aliasPattern(alias), " disease profile ", clauseText);
  const polite = String.raw`\b(?:please|for|this|that|the|a|an|current|anatomy|model|organ|specimen|it|me|i|you|my|would|could|can|want|like|to|in|now|look|make|of)\b|[\s.!?:]+`;
  for (const clause of py.split(String.raw`;|,|\b(?:and|but|while|also|with)\b`, clauseText)) {
    if (!py.sub(polite, "", clause)) continue;
    const grounded = domains.filter(([, pattern]) => py.test(pattern, clause)).map(([domain]) => domain);
    if (!grounded.length || !grounded.some((domain) => represented.has(domain))) return "The model did not ground every requested clause in a supported edit; no partial edit was applied.";
  }
  let healthDown = py.search(String.raw`\b(?:healthier|less diseased|less pathological|less healthy|less severe overall|less severe disease|less sick|more healthy|improved|improving|recovering|reduce both disease|reduce disease severity and contrast)\b`, evidenceSource);
  let healthUp = py.search(String.raw`\b(?:sicker|more diseased|more pathological|unhealthier|worse|increase both disease)\b`, evidenceSource);
  if (evidenceSource.includes("less healthy")) { healthDown = null; healthUp = py.search("less healthy", evidenceSource); }
  if (healthDown && healthUp) return "The disease directions conflict.";
  const percents = py.findall("(" + NUMBER + String.raw`)\s*%`, evidenceSource).map((n) => py.float(n) / 100);
  const touched = new Set(operations.filter((x) => x.op !== "preserve").map((x) => x.field ?? null));
  if ((healthDown || healthUp) && context.disease && !(touched.has("severity") && touched.has("contrast"))) return "The model omitted part of the requested overall disease appearance edit.";
  const at = codePointIndex(evidenceSource);
  for (const item of operations) {
    const { op, field } = item, value = item.value as number;
    const materialAnchors: Record<string, string> = {
      wetness: "wet|drier|dry|moist|sheen|gloss|matte", tint: "tint|warm|cool|redder|less red",
      pigment_contrast: "pigment|mottl", mottle_scale_mm: "mottle scale", fine_detail: "fine detail",
      structure_strength: "structure strength|tissue grain",
    };
    const diseaseAnchors: Record<string, string> = {
      size: "size|lesion|tumou?r|cyst|nodule|region", spread: "spread|widespread|locali[sz]ed",
      irregularity: "irregular|regular", count: "count|sites",
    };
    if (op.startsWith("material_") && !py.test(materialAnchors[field!]!, evidenceSource)) return "The model edited a material field that was not requested.";
    if (op === "disease_relative" && field! in diseaseAnchors && !py.test(diseaseAnchors[field!]!, evidenceSource)) return "The model edited a disease control that was not requested.";
    if (op === "appearance_set") {
      const requestedModes = new Set(py.findall(String.raw`\b(tissue|source|clay)\b`, evidenceSource));
      if (requestedModes.size !== 1 || !requestedModes.has(item.value as string)) return "The model changed appearance without the matching explicit mode request.";
    }
    let relativePercents = percents;
    const comparative = op === "shape_relative" ? shapeComparative(py, evidenceSource, field!) : null;
    if (comparative) relativePercents = comparative.group("pct") ? [py.float(comparative.group("pct")!) / 100] : [];
    const simpleHealth = py.search(String.raw`\b(?:healthier|sicker|less diseased|more diseased|less pathological|more pathological|less healthy|more healthy|less sick|unhealthier|worse|improved|improving|recovering)\b`, evidenceSource);
    if (op === "disease_relative" && (field === "severity" || field === "contrast") && simpleHealth) {
      const prefix = py.search("(" + NUMBER + String.raw`)\s*%\s*$`, evidenceSource.slice(0, simpleHealth.start));
      const suffix = py.match(String.raw`\s*(?:by\s+)?(` + NUMBER + String.raw`)\s*%`, evidenceSource.slice(simpleHealth.end));
      const found = prefix ?? suffix;
      relativePercents = found ? [py.float(found.group(1)!) / 100] : [];
    }
    if (op === "disease_set" && field === "profile_id") {
      if (!c.tables.profile_aliases.some(([alias, profileId]) => profileId === item.value && py.test(aliasPattern(alias), evidenceSource))) return "The model invented a disease profile that was not explicitly requested.";
    }
    if (op === "disease_relative" && (field === "severity" || field === "contrast") && (healthDown || healthUp)) {
      if ((healthDown && value >= 0) || (healthUp && value <= 0)) return "The model reversed the requested disease direction.";
      if (!relativePercents.length && Math.abs(value) !== (py.test(String.raw`\b(?:slightly|a little|somewhat)\b`, evidenceSource) ? 0.1 : 0.2)) return "Comparative health wording uses the declared conservative relative step.";
    }
    if (op.endsWith("_relative") && op !== "material_relative" && relativePercents.length && !relativePercents.some((pct) => Math.abs(Math.abs(value) - Math.abs(pct)) < 1e-7)) return "The model changed a requested relative percentage.";
    if (op.endsWith("_relative") && op !== "material_relative" && relativePercents.length) {
      const anchors: Record<string, string> = {
        width: "width|wide|wider|broader|narrower", height: "height|tall|taller|shorter", depth: "depth|deep|deeper|flatter",
        severity: "healthier|sicker|diseased|health|severity|strength|intensity", contrast: "healthier|sicker|diseased|health|contrast",
        size: "lesion|tumor|tumour|cyst|size", spread: "spread", irregularity: "irregularity|irregular",
      };
      const fieldMatches = py.finditer(String.raw`\b(?:` + (anchors[String(field)] ?? pyEscape(String(field))) + String.raw`)\b`, evidenceSource);
      const percentMatches = py.finditer("(" + NUMBER + String.raw`)\s*%`, evidenceSource);
      if (fieldMatches.length && percentMatches.length) {
        const nearest = firstMin(percentMatches, (p) => Math.min(...fieldMatches.map((a) => Math.min(Math.abs(at(p.end) - at(a.start)), Math.abs(at(p.start) - at(a.end))))));
        if (Math.abs(Math.abs(value) - Math.abs(py.float(nearest.group(1)!)) / 100) > 1e-7) return "The model assigned a percentage to the wrong requested field.";
      }
    }
    if (op === "shape_relative" || op === "shape_absolute") {
      const anchors: Record<string, string> = { width: String.raw`\b(?:width|wide|wider|broader|narrower)\b`, height: String.raw`\b(?:height|tall|taller|shorter)\b`, depth: String.raw`\b(?:depth|deep|deeper|flatter)\b` };
      if (!py.test(anchors[field!]!, evidenceSource) && !(op === "shape_relative" && py.test(String.raw`\b(?:larger|smaller|bigger)\b`, evidenceSource))) return "The model edited a dimension that was not requested.";
      if (op === "shape_relative") {
        const negative = ({ width: "narrower", height: "shorter", depth: "flatter" } as Record<string, string>)[field!]!;
        const positive = ({ width: "wider|broader", height: "taller", depth: "deeper" } as Record<string, string>)[field!]!;
        if ((py.test(String.raw`\b(?:` + negative + String.raw`|smaller)\b`, evidenceSource) && value >= 0) || (py.test(String.raw`\b(?:` + positive + String.raw`|larger|bigger)\b`, evidenceSource) && value <= 0)) return "The model reversed a requested shape direction.";
        if (comparative) {
          const pct = comparative.group("pct");
          if (pct && py.float(pct) <= 0) return "A comparative shape request requires a positive percentage magnitude.";
          const magnitude = pct ? Math.abs(py.float(pct)) / 100 : comparative.group("qualifier") ? 0.03 : 0.05;
          if (Math.abs(Math.abs(value) - magnitude) > 1e-7) return "The model changed the declared comparative shape magnitude.";
        } else {
          const signed = py.search(String.raw`\bchange\s+(?:the\s+)?` + pyEscape(field!) + String.raw`\s+by\s+(` + NUMBER + String.raw`)\s*%`, evidenceSource);
          if (signed && Math.abs(value - py.float(signed.group(1)!) / 100) > 1e-7) return "The model reversed the requested signed dimension change.";
        }
      }
    }
    if (op === "control_set" && !py.test(String.raw`\b` + pyEscape(field!) + String.raw`\b`, evidenceSource)) return "The model changed a shape control that was not requested.";
    if (op === "disease_relative" && field !== "severity" && field !== "contrast") {
      const fieldAnchors = ({ size: "lesion(?:s)?|tumou?r(?:s)?|cyst(?:s)?|size", spread: "spread|widespread|locali[sz]ed", irregularity: "irregular(?:ity)?|regular" } as Record<string, string>)[field!];
      if (fieldAnchors === undefined) throw new PyTypeError(`'${field}'`);
      let negative = String.raw`\b(?:less|reduce|decrease|smaller|down)\b[^,;]*?\b(?:` + fieldAnchors + String.raw`)\b|\b(?:` + fieldAnchors + String.raw`)\b[^,;]*?\b(?:smaller|down|less)\b`;
      let positive = String.raw`\b(?:more|increase|larger|bigger|up)\b[^,;]*?\b(?:` + fieldAnchors + String.raw`)\b|\b(?:` + fieldAnchors + String.raw`)\b[^,;]*?\b(?:larger|bigger|up|more)\b`;
      if (field === "irregularity") {
        negative = String.raw`less irregular|more regular|(?:reduce|decrease)\s+(?:the\s+|disease\s+)?irregularity|irregularity\s+down`;
        positive = String.raw`more irregular|less regular|increase\s+(?:the\s+|disease\s+)?irregularity|irregularity\s+up`;
      }
      if (field === "spread") {
        negative = String.raw`less (?:widespread|spread out)|more locali[sz]ed|(?:reduce|decrease)\s+(?:the\s+|disease\s+)?spread|spread\s+down`;
        positive = String.raw`more (?:widespread|spread out)|less locali[sz]ed|increase\s+(?:the\s+|disease\s+)?spread|spread\s+up`;
      }
      if ((py.test(negative, evidenceSource) && value >= 0) || (py.test(positive, evidenceSource) && value <= 0)) return "The model reversed the requested disease-control direction.";
    }
    if (op === "material_relative") {
      const authoredStep = field === "tint" ? 0.2 : 0.15;
      if (Math.abs(Math.abs(value) - authoredStep) > 1e-7) return "Qualitative surface edits use the declared conservative material step.";
      const directionWords: Record<string, [string, string]> = {
        wetness: ["drier|less moist|less glossy|less sheen|more matte", "wetter|more moist|more glossy|glossier|more sheen"],
        tint: ["cooler|less red", "warmer|redder"],
        pigment_contrast: ["less mottl|reduce.*mottl", "more mottl|increase.*mottl"],
        fine_detail: ["less fine detail", "more fine detail"],
        structure_strength: ["less tissue grain", "more tissue grain"],
      };
      const [negative, positive] = directionWords[field!] ?? ["(?!)", "(?!)"];
      if ((py.test(negative, evidenceSource) && value >= 0) || (py.test(positive, evidenceSource) && value <= 0)) return "The model reversed the requested material direction.";
    }
  }
  const coverage: [string, string][] = [
    ["width", String.raw`\b(?:width|wide|wider|broader|narrower)\b`],
    ["height", String.raw`\b(?:height|tall|taller|shorter)\b`],
    ["depth", String.raw`\b(?:depth|deep|deeper|flatter)\b`],
    ["wetness", String.raw`\b(?:wetness|wetter|drier|moist|glossy|glossier|sheen|matte)\b`],
    ["pigment_contrast", String.raw`\b(?:pigment contrast|mottled|mottling)\b`],
    ["tint", String.raw`\b(?:tint|warmer|cooler|redder)\b`],
    ["bend", String.raw`\bbend\b`], ["twist", String.raw`\btwist\b`], ["taper", String.raw`\btaper\b`], ["asymmetry", String.raw`\basymmetry\b`],
    ["severity", String.raw`\b(?:severity|morphology strength|disease strength|disease intensity)\b`],
    ["size", String.raw`\b(?:lesion size|region size)\b|\b(?:lesions?|tumou?rs?|cysts?)\b[^,;]*?\b(?:smaller|larger|bigger)\b|\b(?:smaller|larger|bigger)\s+(?:lesions?|tumou?rs?|cysts?)\b`],
    ["spread", String.raw`\b(?:spread|widespread)\b`],
    ["irregularity", String.raw`\b(?:irregularity|irregular)\b`],
    ["count", String.raw`\b(?:count|sites)\b`],
  ];
  for (const [field, pattern] of coverage) {
    if (py.test(pattern, evidenceSource) && !touched.has(field) && !(DISEASE_FIELDS.includes(field) && !context.disease && !operations.some((x) => x.op.startsWith("disease_"))))
      return "The model omitted the requested " + field.replaceAll("_", " ") + " edit.";
  }
  const diseaseWords = "health|sick|diseas|patholog|lesion|tumou?r|cyst|nodul|scar|sever|morpholog|swoll|swelling|inflamm|normal|baseline|cirrhos|contrast|spread|irregular|region|pattern|sites|count|size|worse|better|improv|recover|resolve|mild|subtle|aggress|pronounc|inten|prominen|fibros|bulg|retract|enlarg|distend|atroph";
  const materialWords = "wet|dry|drier|moist|sheen|gloss|matte|mottl|pigment|tint|warm|cool|red|detail|grain|structure|textur|material|surface|colour|color|contrast";
  const shapeWords = "width|wide|narrow|height|tall|short|depth|deep|flat|broad|larg|small|big|size|shape|scal|bend|bent|twist|taper|asymmetr|dimension|enlarg|contract|shrink|length";
  for (const item of operations) {
    const { op, field } = item;
    if (op.startsWith("disease_") && op !== "disease_clear" && !py.test(diseaseWords, source)) {
      // explicit profile ids and labels are evidence too
      if (!(op === "disease_set" && field === "profile_id" && c.tables.profile_aliases.some(([alias, profileId]) => profileId === item.value && source.includes(alias)))) return "The model proposed disease edits without disease wording.";
    }
    if (op === "disease_clear" && !py.test(String.raw`\b(?:healthy|normal|normalise|normalize|baseline|clear disease|clear pathology|remove (?:the )?disease|remove (?:the )?pathology|disease free|disease-free|reset disease|reset pathology|restore reference)\b`, source))
      return "The model may clear disease only after an explicit baseline request.";
    if (op.startsWith("material_") && !py.test(materialWords, source)) return "The model proposed material edits without surface wording.";
    if ((op.startsWith("shape_") || op === "control_set") && !py.test(shapeWords, source)) return "The model proposed geometry edits without geometry wording.";
    if (op === "shape_absolute" || op === "control_set" || op === "material_set" || (op === "disease_set" && field !== "profile_id")) {
      const numbers = py.findall(NUMBER, source).map((n) => py.float(n));
      NUMBER_WORDS.forEach((word, i) => { if (py.test(String.raw`\b` + word + String.raw`\b`, source)) numbers.push(i); });
      const expected = Number(item.value);
      if (!numbers.some((n) => Math.abs(n - expected) < 1e-7 || (op === "shape_absolute" && source.includes("cm") && Math.abs(n * 10 - expected) < 1e-7))) return "The model invented a numeric setting not present in the request.";
      const aliases: Record<string, string> = { pigment_contrast: "pigment contrast", mottle_scale_mm: "mottle scale", fine_detail: "fine detail", structure_strength: "structure strength", width: "width|wide", height: "height|tall", depth: "depth|deep", count: "count|sites", severity: "severity|morphology strength|disease strength|disease intensity" };
      const labels = py.finditer(String.raw`\b(?:` + (aliases[field!] ?? pyEscape(field!)) + String.raw`)\b`, evidenceSource);
      if (!labels.length) return "The model assigned a numeric value to a field that was not named.";
      let numericSource = evidenceSource;
      NUMBER_WORDS.forEach((word, i) => { numericSource = py.sub(String.raw`\b` + word + String.raw`\b`, String(i).padEnd(word.length), numericSource); });
      const numericMatches = py.finditer(NUMBER, numericSource);
      if (labels.length && numericMatches.length) {
        // the number words were replaced by ASCII of their own length: positions of both strings agree
        const nearest = firstMin(numericMatches, (n) => Math.min(...labels.map((label) => Math.min(Math.abs(at(n.end) - at(label.start)), Math.abs(at(n.start) - at(label.end))))));
        let actual = py.float(nearest.group(0)!);
        if (op === "shape_absolute") {
          const unit = py.match(String.raw`\s*(mm|cm)\b`, numericSource.slice(nearest.end));
          if (!unit) return "Absolute dimensions require explicit mm or cm units.";
          if (unit.group(1) === "cm") actual *= 10;
        }
        if (Math.abs(actual - expected) > 1e-7) return "The model bound a numeric value to the wrong requested field.";
      }
    }
  }
  return null;
}

const HEALTHIER = ["healthier", "less diseased", "less pathological", "less severe disease", "less sick", "better", "improved", "improving", "recovering", "more healthy"];
const BY_FIELD: Record<string, string> = { "disease severity": "severity", "disease intensity": "severity", "morphology strength": "severity", "lesion size": "size", "region size": "size", "disease contrast": "contrast" };
const DISEASE_LABELS: [string, string][] = [["severity", "severity"], ["morphology strength", "severity"], ["disease intensity", "severity"], ["lesion size", "size"], ["region size", "size"], ["size", "size"], ["spread", "spread"], ["irregularity", "irregularity"], ["disease contrast", "contrast"], ["contrast", "contrast"], ["site count", "count"], ["lesion count", "count"], ["count", "count"]];
const DISEASE_DIRECTIONS: [string, string, number][] = [
  ["(?:smaller|less prominent|reduced)\\s+(?:lesions?|tumou?rs?|cysts?|nodules?|regions?)|(?:lesions?|tumou?rs?|cysts?|nodules?|regions?)\\s+(?:smaller|less prominent)", "size", -1],
  ["(?:larger|bigger|more prominent)\\s+(?:lesions?|tumou?rs?|cysts?|nodules?|regions?)|(?:lesions?|tumou?rs?|cysts?|nodules?|regions?)\\s+(?:larger|bigger|more prominent)", "size", 1],
  ["less (?:severe|intense|pronounced|obvious)|milder(?: disease| pathology)?|reduce (?:the )?(?:severity|disease intensity)", "severity", -1],
  ["more (?:severe|intense|pronounced|obvious)|stronger disease|increase (?:the )?(?:severity|disease intensity)", "severity", 1],
  ["less (?:widespread|spread out)|more localised|more localized|reduce (?:the )?spread", "spread", -1],
  ["more (?:widespread|spread out)|less localised|less localized|increase (?:the )?spread", "spread", 1],
  ["less irregular|more regular|reduce (?:the )?irregularity", "irregularity", -1],
  ["more irregular|less regular|increase (?:the )?irregularity", "irregularity", 1],
  ["less (?:disease |lesion )?contrast|subtler (?:disease |lesion )?(?:color|colour)|reduce (?:the )?(?:disease |lesion )?contrast", "contrast", -1],
  ["more (?:disease |lesion )?contrast|stronger (?:disease |lesion )?(?:color|colour)|increase (?:the )?(?:disease |lesion )?contrast", "contrast", 1],
];
const MORPHOLOGY: [string, string[]][] = [["nodular", ["cirrhosis", "polycystic", "multicystic"]], ["swollen", ["swelling", "enlargement", "distension", "dilation", "pancreatitis"]], ["scarred", ["scarring", "retraction", "infarct", "cirrhosis", "atrophy"]]];
const SHAPE_DIRECTIONS: Record<string, [string, number]> = { wider: ["width", 1], broader: ["width", 1], narrower: ["width", -1], taller: ["height", 1], shorter: ["height", -1], deeper: ["depth", 1], flatter: ["depth", -1], larger: ["all", 1], bigger: ["all", 1], smaller: ["all", -1] };
const MATERIAL_LABELS: [string, string][] = [["tint", "tint"], ["pigment contrast", "pigment_contrast"], ["mottle scale", "mottle_scale_mm"], ["wetness", "wetness"], ["fine detail", "fine_detail"], ["structure strength", "structure_strength"]];
const MATERIAL_WORDS: [string, string, number][] = [["wetter|more moist|more glossy|glossier|more sheen", "wetness", 0.15], ["drier|less moist|less glossy|more matte|less sheen", "wetness", -0.15], ["warmer|redder", "tint", 0.2], ["cooler|less red", "tint", -0.2], ["more mottled|more mottling", "pigment_contrast", 0.15], ["less mottled|less mottling", "pigment_contrast", -0.15], ["more fine detail", "fine_detail", 0.15], ["less fine detail", "fine_detail", -0.15], ["more tissue grain", "structure_strength", 0.15], ["less tissue grain", "structure_strength", -0.15]];

/** parse_semantic: the deterministic wording plan */
function parseSemantic(c: Compiler, text: string, context: Context): Plan {
  const py = c.py;
  const refusal = requestGuard(c, text, context);
  if (refusal) return refusal;
  let [remaining, ops] = extractPreserves(py, py.rstripDotBang(normalise(py, text)));
  const notes: string[] = [];
  try {
    // explicit profiles longest first, so a short alias is not consumed inside a longer one
    const selected: string[] = [];
    for (const [alias, profileId] of c.profileAliasesByLength) {
      const pattern = aliasPattern(alias);
      if (py.test(pattern, remaining)) { selected.push(profileId); remaining = py.sub(pattern, " ", remaining); }
    }
    if (new Set(selected).size > 1) return refuse("Choose one external disease profile per request.");
    if (selected.length) ops.push(operation("disease_set", "profile_id", selected[0]!));
    const active = Boolean(context.disease || selected.length);
    remaining = py.sub(String.raw`\b(?:(?P<percent>\d+(?:\.\d+)?)\s*%\s*|(?P<qualifier>slightly|a little|somewhat|much)\s+)?(?P<health>less severe disease|less pathological|less diseased|more diseased|more pathological|more unhealthy|more healthy|less healthy|less sick|healthier|sicker|unhealthier|worse|better|improved|improving|recovering)\b`, (m) => {
      const direction = HEALTHIER.includes(m.group("health")!) ? -1 : 1;
      const percent = m.group("percent"), qualifier = m.group("qualifier");
      const fraction = percent ? py.float(percent) / 100 : qualifier === "slightly" || qualifier === "a little" || qualifier === "somewhat" ? 0.1 : 0.2;
      if (!(0 < fraction && fraction <= 0.95)) throw new PyValueError("Relative disease changes must be between 0% and 95%.");
      if (!active) {
        if (direction > 0) throw new PyLookupError("Select a disease profile before asking for a more diseased appearance.");
        notes.push("Already at the authored baseline; healthier leaves the recipe unchanged.");
      } else {
        ops.push(operation("disease_relative", "severity", pyRound(direction * fraction, 8)), operation("disease_relative", "contrast", pyRound(direction * fraction, 8)));
        notes.push("Health wording changes authored morphology strength and color contrast, not measured health or clinical stage.");
      }
      return " ";
    }, remaining);
    const baseline = String.raw`\b(?:normalise|normalize|return to (?:the )?(?:normal|baseline)|restore (?:the )?(?:normal|baseline)|clear disease|clear pathology|remove (?:the )?disease|remove (?:the )?pathology|reset disease|reset pathology|disease[- ]free|healthy|baseline|normal)\b`;
    if (py.test(baseline, remaining)) {
      remaining = py.sub(baseline, " ", remaining);
      ops.push(operation("disease_clear"));
      notes.push("Baseline clears the selected authored disease recipe and preserves shape and material.");
    }
    remaining = py.sub(String.raw`\b(?:lesions?|tumou?rs?|cysts?|nodules?|regions?)\s+(?P<percent>\d+(?:\.\d+)?)\s*%\s*(?P<direction>smaller|larger|bigger)\b`, (m) => {
      ops.push(operation("disease_relative", "size", (m.group("direction") === "smaller" ? -1 : 1) * py.float(m.group("percent")!) / 100));
      return " ";
    }, remaining);
    remaining = py.sub(String.raw`\b(?P<verb>reduce|decrease|increase)\s+(?:the\s+)?(?P<field>disease severity|disease intensity|morphology strength|lesion size|region size|disease contrast|severity|spread|irregularity|contrast)\s+by\s+(?P<percent>\d+(?:\.\d+)?)\s*%`, (m) => {
      const label = m.group("field")!, verb = m.group("verb");
      ops.push(operation("disease_relative", BY_FIELD[label] ?? label, (verb === "reduce" || verb === "decrease" ? -1 : 1) * py.float(m.group("percent")!) / 100));
      return " ";
    }, remaining);
    // disease parameters by their authored names and common aliases
    for (const [label, field] of byLengthDesc(py, DISEASE_LABELS, ([name]) => name)) {
      remaining = py.sub((label === "contrast" ? "(?<!pigment )" : "") + String.raw`\b` + pyEscape(label) + String.raw`\s*(?:to|=|:)?\s*(` + NUMBER + String.raw`)\b(?!\s*(?:%|mm|cm))`, (m) => {
        const value = py.float(m.group(1)!);
        if (field === "count" && !Number.isInteger(value)) throw new PyValueError("Disease site count must be an integer.");
        ops.push(operation("disease_set", field, field === "count" ? Math.trunc(value) + 0 : value));
        return " ";
      }, remaining);
    }
    for (const [pattern, field, sign] of DISEASE_DIRECTIONS) {
      remaining = py.sub(String.raw`\b(?:(?P<pct>\d+(?:\.\d+)?)\s*%\s*)?(?:` + pattern + String.raw`)\b`, (m) => {
        const pct = m.group("pct");
        ops.push(operation("disease_relative", field, pyRound(sign * (pct ? py.float(pct) / 100 : 0.2), 8)));
        return " ";
      }, remaining);
    }
    for (const [word, required] of MORPHOLOGY) {
      const pattern = String.raw`\b(less|more)\s+` + word + String.raw`\b`;
      if (py.test(pattern, remaining)) {
        const profileId = selected.length ? selected[0]! : context.disease?.profile_id ?? "";
        if (!required.some((token) => profileId.includes(token))) throw new PyLookupError(`Select a compatible external ${word} profile before changing that appearance.`);
        remaining = py.sub(pattern, (m) => { ops.push(operation("disease_relative", "severity", m.group(1) === "less" ? -0.2 : 0.2)); return " "; }, remaining);
      }
    }
    // measured organ dimensions are solved only at atomic apply time
    const absolute = (m: PyMatch): string => {
      const axis = m.group("axis")!;
      ops.push(operation("shape_absolute", ({ wide: "width", tall: "height", deep: "depth" } as Record<string, string>)[axis] ?? axis, pyRound(py.float(m.group("number")!) * (m.group("unit") === "cm" ? 10 : 1), 8)));
      return " ";
    };
    remaining = py.sub(String.raw`\b(?P<axis>width|height|depth)\s*(?:of|to|=|:)?\s*(?P<number>` + NUMBER + String.raw`)\s*(?P<unit>mm|cm)\b`, absolute, remaining);
    remaining = py.sub(String.raw`\b(?P<number>` + NUMBER + String.raw`)\s*(?P<unit>mm|cm)\s*(?P<axis>wide|tall|deep)\b`, absolute, remaining);
    remaining = py.sub(String.raw`\b(?:(?P<pct>\d+(?:\.\d+)?)\s*%\s*|(?P<qualifier>slightly|a little)\s+)?(?P<direction>` + Object.keys(SHAPE_DIRECTIONS).join("|") + String.raw`)\b`, (m) => {
      const [field, sign] = SHAPE_DIRECTIONS[m.group("direction")!]!;
      const pct = m.group("pct"), qualifier = m.group("qualifier");
      const fraction = pct ? py.float(pct) / 100 : qualifier === "slightly" || qualifier === "a little" ? 0.03 : 0.05;
      for (const target of field === "all" ? DIMENSIONS : [field]) ops.push(operation("shape_relative", target, pyRound(sign * fraction, 8)));
      return " ";
    }, remaining);
    for (const field of CONTROLS)
      remaining = py.sub(String.raw`\b` + field + String.raw`\s*(?:to|=|:)?\s*(` + NUMBER + String.raw`)\b`, (m) => { ops.push(operation("control_set", field, py.float(m.group(1)!))); return " "; }, remaining);
    for (const [label, field] of MATERIAL_LABELS)
      remaining = py.sub(String.raw`\b` + label + String.raw`\s*(?:to|=|:)?\s*(` + NUMBER + String.raw`)\b` + (field === "mottle_scale_mm" ? String.raw`(?:\s*mm)?` : ""), (m) => { ops.push(operation("material_set", field, py.float(m.group(1)!))); return " "; }, remaining);
    for (const [pattern, field, delta] of MATERIAL_WORDS)
      remaining = py.sub(String.raw`\b(?:` + pattern + String.raw`)\b`, () => { ops.push(operation("material_relative", field, delta)); return " "; }, remaining);
    for (const appearance of ["tissue", "clay", "source"]) {
      const pattern = String.raw`\b` + appearance + String.raw`(?:\s+appearance)?\b`;
      if (py.test(pattern, remaining)) { ops.push(operation("appearance_set", "appearance", appearance)); remaining = py.sub(pattern, " ", remaining); }
    }
    const mentioned = new Set<string>();
    for (const [alias, organ] of c.organAliasesByLength) {
      const pattern = String.raw`\b` + pyEscape(alias) + String.raw`\b`;
      if (py.test(pattern, remaining)) { mentioned.add(organ); remaining = py.sub(pattern, " ", remaining); }
    }
    if (mentioned.size && !(mentioned.size === 1 && context.organ !== null && mentioned.has(context.organ))) return refuse("Select the requested organ first; this edit applies to the current anatomy.", "clarify");
    remaining = py.sub(String.raw`\b(?:make|the|a|an|please|generate|create|show|use|select|organ|reference|shape|and|with|set|to|be|it|look|looking|appear|appearance|this|current|my|model|specimen|slightly|somewhat|now|then|but|while|also|for me)\b`, " ", remaining);
    remaining = py.strip(py.sub(String.raw`[\s,;:.!?]+`, " ", remaining));
    if (remaining) return refuse("The request contains wording that needs clarification: " + remaining + ". No partial edit was applied.", "clarify");
    if (!ops.length && !notes.length) return refuse("Name a shape, material or disease-appearance edit.", "clarify");
    const plan = makePlan(ops, "accepted", notes.join(" ") || "Prepared bounded anatomy appearance edits; unspecified recipe fields are preserved.");
    return validatePlan(c, plan, context, text);
  } catch (error) {
    if (error instanceof PyLookupError) return refuse(error.message, "clarify");
    if (error instanceof PyValueError) return refuse(error.message);
    throw error;
  }
}

const MESSAGE_LABELS: Record<string, string> = { severity: "disease strength", size: "disease region size", contrast: "disease color contrast", wetness: "surface sheen", pigment_contrast: "surface mottling" };
/** _application_message: the applied operations explained from trusted code */
function applicationMessage(ops: Op[], context: Context): string {
  const active = ops.filter((item) => item.op !== "preserve");
  if (!active.length) return context.disease ? "The requested fields were preserved; no edit was applied." : "No disease modifier is active; the anatomy is unchanged.";
  const fields = new Set(active.map((x) => x.field));
  if (active.length === 2 && fields.size === 2 && fields.has("severity") && fields.has("contrast") && active.every((x) => x.op === "disease_relative") && active[0]!.value === active[1]!.value) {
    const value = active[0]!.value as number;
    return `${value < 0 ? "Reduced" : "Increased"} the selected disease strength and color contrast by ${pyFormatG(Math.abs(value) * 100)}%. Other recipe controls are unchanged.`;
  }
  return active.map((item) => {
    const { op, field } = item, value = item.value as number;
    const label = MESSAGE_LABELS[field ?? ""] ?? (field ?? "").replaceAll("_", " ");
    if (op === "disease_clear") return "Cleared the disease modifier";
    if (op === "disease_relative" || op === "shape_relative") return `${value < 0 ? "Reduced" : "Increased"} ${label} by ${pyFormatG(Math.abs(value) * 100)}%`;
    if (op === "material_relative") return `${value < 0 ? "Reduced" : "Increased"} ${label}`;
    if (op === "shape_absolute") return `Set ${label} to ${pyFormatG(value)} mm`;
    return `Set ${label} to ${typeof item.value === "string" ? item.value : intValued(item) ? String(value + 0) : pyRepr(value)}`;
  }).join("; ") + ".";
}

/** apply_plan: every validated operation on a copy; any failure applies none */
async function applyPlan(session: Session, spec: V2Dump, plan: Plan, text: string): Promise<Result> {
  const { c } = session;
  const organ = c.template(spec.template_id).organ;
  const context = contextFromSpec(spec, organ);
  plan = validatePlan(c, plan, context, text);
  if (plan.status !== "accepted") return withPolicy(plan);
  const target = clone(spec) as unknown as Dict;
  const geometry: string[] = [];
  let disease = (target.disease ?? null) as Dict | null;
  let material = (target.material ?? null) as Dict | null;
  const ops = plan.operations;
  try {
    const profile = ops.find((x) => x.op === "disease_set" && x.field === "profile_id")?.value;
    if (profile) disease = disease && disease.profile_id === profile ? disease : c.specs.diseaseDefaults(String(profile), (target.seed as number | undefined) ?? 42) as unknown as Dict;
    for (const item of ops) {
      const { op } = item, field = item.field!, value = item.value!;
      if (op === "disease_clear") disease = null;
      else if (op === "disease_relative") {
        if (!disease) throw new PyTypeError("'NoneType' object is not subscriptable");
        disease[field] = pyRound(Math.min(1, Math.max(0, (disease[field] as number) * (1 + (value as number)))), 8);
      } else if (op === "disease_set" && field !== "profile_id") {
        if (!disease) throw new PyTypeError("'NoneType' object does not support item assignment");
        disease[field] = value;
      } else if (op === "shape_relative") {
        const direction = ({ width: ["wider", "narrower"], height: ["taller", "shorter"], depth: ["deeper", "flatter"] } as Record<string, [string, string]>)[field]![(value as number) < 0 ? 1 : 0];
        geometry.push(`${pyFormatG(Math.abs(value as number) * 100)}% ${direction}`);
      } else if (op === "shape_absolute") geometry.push(`${field} ${pyFormatG(value as number)} mm`);
      else if (op === "control_set") geometry.push(`${field} ${pyFormatG(value as number)}`);
      else if (op === "material_relative" || op === "material_set") {
        material = material ?? (c.specs.makeRecipe(organ, "balanced", 42) as unknown as Dict);
        const [lo, hi] = MATERIAL_BOUNDS[field]!;
        material[field] = op === "material_relative" ? pyRound(Math.min(hi, Math.max(lo, (material[field] as number) + (value as number))), 8) : value;
        target.appearance = "tissue";
      } else if (op === "appearance_set") {
        target.appearance = value;
        if (value !== "tissue") material = null;
      }
    }
    if (geometry.length) {
      const preservedDimensions = new Set(ops.filter((item) => item.op === "preserve" && DIMENSIONS.includes(item.field!)).map((item) => item.field!));
      if (preservedDimensions.size) {
        if (disease !== null) return withPolicy(refuse("Preserved final dimensions of a diseased surface cannot currently be solved. No edit was applied.", "clarify"));
        const template = c.template(spec.template_id);
        const extent = deformedExtents(await session.rest(spec.template_id), spec.controls, template.control_limits, template.normalization_mm);
        for (const field of [...preservedDimensions].sort()) geometry.push(`${field} ${pyFormatG(extent[DIMENSIONS.indexOf(field)]!, 17)} mm`);
      }
      target.material = material;
      const surface = c.specs.surface(Object.fromEntries(Object.entries(target).filter(([key]) => key !== "disease" && key !== "renderer_version")));
      const result = await compileSurface(session, geometry.join(", "), surface);
      if (result.status !== "accepted") return withPolicy(refuse(result.message));
      Object.assign(target, result.spec as Dict);
    }
    if (material !== null) material = c.specs.material(material) as unknown as Dict;
    target.material = material;
    target.disease = disease;
    target.template_sha256 = null;
    target.realized_id = null;
    const parsed = c.specs.v2(target);
    const summary = applicationMessage(ops, context);
    plan.message = summary;
    return { status: "accepted", spec: dumpSpec(parsed, "v2"), message: summary, policy_version: SEMANTIC_POLICY_VERSION, semantic_plan: plan, plan_sha256: planFingerprint(plan), interpretation: INTERPRETATION };
  } catch (error) {
    if (error instanceof PyValueError || error instanceof PyTypeError) return withPolicy(refuse(error.message));
    throw error;
  }
}

/** atlas_semantic.compile_text */
async function compileSemantic(session: Session, text: string, spec: V2Dump): Promise<Result> {
  const context = contextFromSpec(spec, session.c.template(spec.template_id).organ);
  return applyPlan(session, spec, parseSemantic(session.c, text, context), text);
}

// ---------------------------------------------------------------------------------------------- the route
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const checkedLibraries = new WeakMap<AtlasCatalog, WeakSet<TextCompilerTables>>();
/** The studio's catalogue and the tables must describe the same library: every template it offers is one the tables
 *  know, with the same organ, control limits and normalisation (checked once per catalogue). */
function checkLibrary(c: Compiler, library: AtlasCatalog): void {
  if (checkedLibraries.get(library)?.has(c.tables)) return;
  for (const organ of library.organs) for (const template of organ.templates) {
    const entry = c.templates.get(template.id);
    const limits = template.control_limits, normalization = template.normalization_mm;
    if (!entry || entry.organ !== organ.id || (Array.isArray(limits) && limits.join() !== entry.control_limits.join()) || (typeof normalization === "number" && normalization !== entry.normalization_mm))
      throw new Error(`The text compiler tables do not describe this anatomy library (${template.id}).`);
  }
  let seen = checkedLibraries.get(library);
  if (!seen) { seen = new WeakSet(); checkedLibraries.set(library, seen); }
  seen.add(c.tables);
}

/** POST /api/atlas/compile for a disease-v2 spec, in the browser: the route's JSON answer, field for field — status
 *  ("accepted" | "clarify" | "unsupported"), message, spec, policy_version and whatever else the answering compiler
 *  adds (semantic_plan, plan_sha256, interpretation, measured_extent_mm, …) — for the request body
 *  { text, spec } without use_trained_language (that adapter stays with the API).
 *  `library` is the catalogue the studio shows (static/api/atlas/catalog.json in the public copy); it must describe
 *  the tables' library (checked once). `references(templateId)` hands over a template's bundled reference specimen
 *  (atlasLocal.ts bundledReference): its rest_positions are the vertices the compiler measures — the current
 *  template's for a dimension edit or an accepted shape answer, another template's when the text switches the
 *  reference ("the male liver"). It is called only when a measurement is needed, so a refusal never downloads one.
 *  A request FastAPI would refuse (422) or a template the library lacks (404) throws TextCompilerRequestError with the
 *  API's detail text. The caller treats the answer as it treats the API's: a refusal shows its message, an accepted
 *  answer's spec goes through validateAtlasSpec and is realized like any other spec. */
export async function compileTextLocally(text: string, spec: AtlasSpec, library: AtlasCatalog, references: (templateId: string) => Promise<AtlasGeneration>): Promise<Record<string, unknown>> {
  const c = compilerFor(await loadTextCompilerTables());
  checkLibrary(c, library);
  // CompileRequest: text of 1..4000 characters (code points), a DiseaseAtlasSpecV2 spec
  if (typeof text !== "string") throw new TextCompilerRequestError(422, "Input should be a valid string");
  // pydantic refuses a lone surrogate before it counts characters; the API safely escapes its 422 detail.
  if (LONE_SURROGATE.test(text)) throw new TextCompilerRequestError(422, "Input should be a valid string, unable to parse raw data as a unicode string");
  const length = c.py.len(text);
  if (length < 1) throw new TextCompilerRequestError(422, "String should have at least 1 character");
  if (length > MAX_TEXT_LENGTH) throw new TextCompilerRequestError(422, "String should have at most 4000 characters");
  if (!isDict(spec) || spec.renderer_version !== "disease-v2") throw new TextCompilerRequestError(422, "This compiler answers disease-v2 specs; a legacy spec needs the VISCERA API.");
  let parsed: V2Dump;
  try { parsed = c.specs.v2(spec); } catch (error) {
    if (error instanceof ValidationError) throw new TextCompilerRequestError(422, error.message.split("\n").filter((line) => line.startsWith("  ")).map((line) => line.trim()).join("; "));
    throw error;
  }
  const session = new Session(c, references);
  const guarded = requestGuard(c, text, contextFromSpec(parsed));
  if (guarded) return withPolicy(guarded);
  const original = await compileDiseaseText(session, text, parsed);
  if (original.status === "accepted") return original;
  return compileSemantic(session, text, parsed);
}
