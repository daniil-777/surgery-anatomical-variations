// Layer metadata of the root USD layer inside a USDZ package: who wrote it (customLayerData.creator, doc) and its
// stage conventions (upAxis, metersPerUnit). Text layers (.usda) are read with a few patterns; binary crate layers
// (.usdc) go through three.js's own crate parser.

import { USDCParser } from "three/examples/jsm/loaders/usd/USDCParser.js";
import { startsWithAscii, toArrayBuffer, utf8Text } from "./bytes";
import { errorMessage } from "./errors";

export interface UsdLayerMeta {
  creator: string | null;
  doc: string | null;
  upAxis: "Y" | "Z" | null;
  /** null when not authored (USD then assumes 0.01, i.e. centimetres). */
  metersPerUnit: number | null;
  /** Set when the layer could not be read. */
  error: string | null;
}

function empty(error: string | null = null): UsdLayerMeta {
  return { creator: null, doc: null, upAxis: null, metersPerUnit: null, error };
}

export function isUsdCrate(bytes: Uint8Array): boolean {
  return startsWithAscii(bytes, "PXR-USDC");
}

/** The metadata block of a text layer: "#usda 1.0" followed by "( … )" before the first prim. */
export function readUsdaMeta(text: string): UsdLayerMeta {
  const firstPrim = text.search(/^\s*(def|over|class)\s/m);
  const header = firstPrim > 0 ? text.slice(0, firstPrim) : text.slice(0, 64 * 1024);
  const meta = empty();
  const creator = /\bstring\s+creator\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(header)?.[1];
  const doc = /\bdoc\s*=\s*(?:"""([\s\S]*?)"""|"((?:[^"\\]|\\.)*)")/.exec(header);
  const upAxis = /\bupAxis\s*=\s*"([A-Za-z])"/.exec(header)?.[1]?.toUpperCase();
  const meters = /\bmetersPerUnit\s*=\s*([-+0-9.eE]+)/.exec(header)?.[1];
  meta.creator = creator?.trim() || null;
  meta.doc = (doc?.[1] ?? doc?.[2])?.trim() || null;
  meta.upAxis = upAxis === "Y" || upAxis === "Z" ? upAxis : null;
  const metersPerUnit = meters === undefined ? NaN : Number(meters);
  meta.metersPerUnit = Number.isFinite(metersPerUnit) && metersPerUnit > 0 ? metersPerUnit : null;
  return meta;
}

/** Root-layer fields of a binary crate layer. */
export function readUsdcMeta(bytes: Uint8Array): UsdLayerMeta {
  try {
    const parsed = new USDCParser().parseData(toArrayBuffer(bytes));
    const fields = parsed.specsByPath["/"]?.fields ?? {};
    const meta = empty();
    const custom = fields.customLayerData;
    if (custom && typeof custom === "object" && "creator" in custom && typeof custom.creator === "string") meta.creator = custom.creator.trim() || null;
    // Text layers say `doc = "…"`; in a crate the same field is stored as "documentation".
    const doc = fields.documentation ?? fields.doc;
    if (typeof doc === "string") meta.doc = doc.trim() || null;
    if (fields.upAxis === "Y" || fields.upAxis === "Z") meta.upAxis = fields.upAxis;
    if (typeof fields.metersPerUnit === "number" && Number.isFinite(fields.metersPerUnit) && fields.metersPerUnit > 0) meta.metersPerUnit = fields.metersPerUnit;
    return meta;
  } catch (error) {
    return empty(errorMessage(error));
  }
}

export function readUsdLayerMeta(bytes: Uint8Array): UsdLayerMeta {
  return isUsdCrate(bytes) ? readUsdcMeta(bytes) : readUsdaMeta(utf8Text(bytes, 0, Math.min(bytes.length, 256 * 1024)));
}
