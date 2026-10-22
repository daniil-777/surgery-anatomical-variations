// The FBX header: who wrote the file (Creator, SceneInfo application fields) and its global settings (up axis, unit
// scale). Binary files are walked record by record, skipping every top-level record except FBXHeaderExtension, Creator
// and GlobalSettings without reading its contents; text files are scanned line by line. Both readers are bounded and
// never throw: a damaged header just yields fewer facts (the loader reports real damage).

import { readU32, readU64, startsWithAscii, utf8Text } from "./bytes";

export interface FbxApplication {
  vendor: string | null;
  name: string | null;
  version: string | null;
}

export interface FbxHeader {
  encoding: "binary" | "text";
  /** 7400 for FBX 7.4, … (null when unknown). */
  version: number | null;
  /** FBXHeaderExtension/Creator or the top-level Creator. */
  creator: string | null;
  /** SceneInfo "Original|…": the application that first created the scene. */
  original: FbxApplication;
  /** SceneInfo "LastSaved|…": the application that wrote this file. */
  lastSaved: FbxApplication;
  /** "Original|ApplicationNativeFile" (a path on the author's machine — only its extension is ever shown). */
  nativeFile: string | null;
  /** SceneInfo "DocumentUrl" (also a local path; used only as a hint). */
  documentUrl: string | null;
  /** SceneInfo MetaData. */
  title: string | null;
  author: string | null;
  /** GlobalSettings: 0 = X, 1 = Y, 2 = Z. */
  upAxis: number | null;
  /** GlobalSettings UnitScaleFactor: centimetres per file unit (1 = cm, 100 = m). */
  unitScaleFactor: number | null;
}

const BINARY_MAGIC = "Kaydara FBX Binary  \0";
const MAX_TOP_LEVEL = 64;
const MAX_NODES = 4096;
const MAX_DEPTH = 8;

type FbxValue = string | number | boolean | null;

interface FbxNode {
  name: string;
  values: FbxValue[];
  children: FbxNode[];
}

function emptyApplication(): FbxApplication {
  return { vendor: null, name: null, version: null };
}

function emptyHeader(encoding: "binary" | "text", version: number | null): FbxHeader {
  return {
    encoding,
    version,
    creator: null,
    original: emptyApplication(),
    lastSaved: emptyApplication(),
    nativeFile: null,
    documentUrl: null,
    title: null,
    author: null,
    upAxis: null,
    unitScaleFactor: null,
  };
}

export function isBinaryFbx(bytes: Uint8Array): boolean {
  return startsWithAscii(bytes, BINARY_MAGIC);
}

/** Reads the header of a binary or text FBX file (whole file, or at least its first few hundred kilobytes). */
export function readFbxHeader(bytes: Uint8Array): FbxHeader {
  return isBinaryFbx(bytes) ? readBinaryHeader(bytes) : readTextHeader(utf8Text(bytes, 0, Math.min(bytes.length, 1024 * 1024)));
}

// Binary ------------------------------------------------------------------------------------------------------------

class BinaryReader {
  readonly bytes: Uint8Array;
  /** FBX 7.5 and later use 64-bit record offsets. */
  readonly wide: boolean;
  nodes = 0;

  constructor(bytes: Uint8Array, wide: boolean) {
    this.bytes = bytes;
    this.wide = wide;
  }

  private offset(at: number): number {
    return this.wide ? readU64(this.bytes, at) : readU32(this.bytes, at);
  }

  get recordHeaderSize(): number {
    return this.wide ? 25 : 13;
  }

  /** Name and end of the record at `at`, or null for the terminating null record / damage. */
  head(at: number): { name: string; end: number; propertyCount: number; propertyBytes: number; propertiesAt: number } | null {
    const size = this.recordHeaderSize;
    if (at + size > this.bytes.length) return null;
    const end = this.offset(at);
    const propertyCount = this.offset(at + (this.wide ? 8 : 4));
    const propertyBytes = this.offset(at + (this.wide ? 16 : 8));
    const nameLength = this.bytes[at + size - 1]!;
    if (end === 0) return null;
    if (!Number.isSafeInteger(end) || end <= at || end > this.bytes.length) return null;
    const propertiesAt = at + size + nameLength;
    if (propertiesAt + propertyBytes > end) return null;
    const name = utf8Text(this.bytes, at + size, at + size + nameLength);
    return { name, end, propertyCount, propertyBytes, propertiesAt };
  }

  node(at: number, depth: number): FbxNode | null {
    const head = this.head(at);
    if (!head || ++this.nodes > MAX_NODES) return null;
    const values = this.properties(head.propertiesAt, head.propertyCount, head.propertiesAt + head.propertyBytes);
    const children: FbxNode[] = [];
    let child = head.propertiesAt + head.propertyBytes;
    if (depth < MAX_DEPTH) {
      while (child + this.recordHeaderSize <= head.end) {
        const childHead = this.head(child);
        if (!childHead) break;
        const parsed = this.node(child, depth + 1);
        if (parsed) children.push(parsed);
        child = childHead.end;
      }
    }
    return { name: head.name, values, children };
  }

  private properties(at: number, count: number, end: number): FbxValue[] {
    const values: FbxValue[] = [];
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    for (let i = 0; i < count && at < end; i++) {
      const type = String.fromCharCode(this.bytes[at]!);
      at += 1;
      switch (type) {
        case "S":
        case "R": {
          const length = readU32(this.bytes, at);
          if (at + 4 + length > end) return values;
          values.push(type === "S" ? utf8Text(this.bytes, at + 4, at + 4 + length) : null);
          at += 4 + length;
          break;
        }
        case "Y":
          values.push(view.getInt16(at, true));
          at += 2;
          break;
        case "C":
          values.push(this.bytes[at] !== 0);
          at += 1;
          break;
        case "I":
          values.push(view.getInt32(at, true));
          at += 4;
          break;
        case "F":
          values.push(view.getFloat32(at, true));
          at += 4;
          break;
        case "D":
          values.push(view.getFloat64(at, true));
          at += 8;
          break;
        case "L":
          values.push(Number(view.getBigInt64(at, true)));
          at += 8;
          break;
        case "f":
        case "d":
        case "l":
        case "i":
        case "b": {
          const length = readU32(this.bytes, at);
          const encoding = readU32(this.bytes, at + 4);
          const compressed = readU32(this.bytes, at + 8);
          const element = type === "d" || type === "l" ? 8 : type === "b" ? 1 : 4;
          at += 12 + (encoding === 1 ? compressed : length * element);
          values.push(null);
          break;
        }
        default:
          return values;
      }
    }
    return values;
  }
}

function readBinaryHeader(bytes: Uint8Array): FbxHeader {
  const version = bytes.length >= 27 ? readU32(bytes, 23) : null;
  const header = emptyHeader("binary", version);
  if (version === null) return header;
  const reader = new BinaryReader(bytes, version >= 7500);
  let at = 27;
  for (let i = 0; i < MAX_TOP_LEVEL; i++) {
    const head = reader.head(at);
    if (!head) break;
    if (head.name === "FBXHeaderExtension" || head.name === "GlobalSettings" || head.name === "Creator") {
      const node = reader.node(at, 0);
      if (node) applyNode(header, node);
    }
    at = head.end;
  }
  return header;
}

function stringValue(node: FbxNode | undefined, index = 0): string | null {
  const value = node?.values[index];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: FbxValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function applyNode(header: FbxHeader, node: FbxNode): void {
  if (node.name === "Creator") {
    header.creator ??= stringValue(node);
    return;
  }
  if (node.name === "FBXHeaderExtension") {
    for (const child of node.children) {
      if (child.name === "Creator") header.creator = stringValue(child) ?? header.creator;
      if (child.name === "FBXVersion") header.version = numberValue(child.values[0]) ?? header.version;
      if (child.name === "SceneInfo") {
        for (const part of child.children) {
          if (part.name === "MetaData") {
            header.title = stringValue(part.children.find((entry) => entry.name === "Title"));
            header.author = stringValue(part.children.find((entry) => entry.name === "Author"));
          }
          if (part.name === "Properties70" || part.name === "Properties60") {
            for (const property of part.children) applySceneProperty(header, property.values);
          }
        }
      }
    }
    return;
  }
  if (node.name === "GlobalSettings") {
    for (const child of node.children) {
      if (child.name !== "Properties70" && child.name !== "Properties60") continue;
      for (const property of child.children) applyGlobalProperty(header, property.values);
    }
  }
}

/** P: "Original|ApplicationName", "KString", "", "", "Blender (stable FBX IO)" — the value is the last field. */
function applySceneProperty(header: FbxHeader, values: FbxValue[]): void {
  const key = values[0];
  const last = values[values.length - 1];
  if (typeof key !== "string" || values.length < 4) return;
  setSceneField(header, key, typeof last === "string" && last.trim() ? last.trim() : null);
}

function setSceneField(header: FbxHeader, key: string, text: string | null): void {
  switch (key) {
    case "Original|ApplicationVendor":
      header.original.vendor = text;
      break;
    case "Original|ApplicationName":
      header.original.name = text;
      break;
    case "Original|ApplicationVersion":
      header.original.version = text;
      break;
    case "LastSaved|ApplicationVendor":
      header.lastSaved.vendor = text;
      break;
    case "LastSaved|ApplicationName":
      header.lastSaved.name = text;
      break;
    case "LastSaved|ApplicationVersion":
      header.lastSaved.version = text;
      break;
    case "Original|ApplicationNativeFile":
      header.nativeFile = text;
      break;
    case "DocumentUrl":
      header.documentUrl = text;
      break;
    default:
      break;
  }
}

function applyGlobalProperty(header: FbxHeader, values: FbxValue[]): void {
  const key = values[0];
  const value = numberValue(values[values.length - 1]);
  if (key === "UpAxis" && value !== null) header.upAxis = value;
  if (key === "UnitScaleFactor" && value !== null && value > 0) header.unitScaleFactor = value;
}

// Text --------------------------------------------------------------------------------------------------------------

/** FBX text escapes quotes as &quot; and never uses backslash escapes (Windows paths keep their backslashes). */
function unescapeText(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lf;/g, "\n").replace(/&cr;/g, "\r");
}

function readTextHeader(full: string): FbxHeader {
  // The header and GlobalSettings come before Definitions and Objects, which can be megabytes of P: lines.
  const cut = full.search(/^\s*(Definitions|Objects):/m);
  const text = cut > 0 ? full.slice(0, cut) : full;
  const declared = /^\s*;\s*FBX\s+(\d+)\.(\d+)\.(\d+)/.exec(text);
  const fbxVersion = /\bFBXVersion:\s*(\d+)/.exec(text);
  const version = declared ? Number(declared[1]) * 1000 + Number(declared[2]) * 100 + Number(declared[3]) : fbxVersion ? Number(fbxVersion[1]) : null;
  const header = emptyHeader("text", version);
  const creator = /^[ \t]*Creator:[ \t]*"([^"]*)"/m.exec(text)?.[1]?.trim();
  if (creator) header.creator = unescapeText(creator);

  // FBX 7: P: "Name", "Type", "Label", "Flags", value…   FBX 6: Property: "Name", "Type", "Flags", value…
  const property = /^[ \t]*(?:P|Property):[ \t]*"([^"]*)"(.*)$/gm;
  let match: RegExpExecArray | null;
  let scanned = 0;
  while ((match = property.exec(text)) !== null && scanned++ < 4000) {
    const key = match[1] ?? "";
    const fields = splitFields(match[2] ?? "");
    const last = (fields[fields.length - 1] ?? "").trim();
    if (/^(Original|LastSaved)\|Application(Vendor|Name|Version|NativeFile)$|^DocumentUrl$/.test(key)) {
      const quoted = /^"([^"]*)"$/.exec(last)?.[1]?.trim();
      setSceneField(header, key, quoted ? unescapeText(quoted) : null);
    } else if (key === "UpAxis" || key === "UnitScaleFactor") {
      const value = Number(last);
      if (last !== "" && Number.isFinite(value)) applyGlobalProperty(header, [key, value]);
    }
  }
  const metadata = /MetaData:\s*\{([\s\S]*?)\}/.exec(text)?.[1] ?? "";
  const title = /^[ \t]*Title:[ \t]*"([^"]*)"/m.exec(metadata)?.[1]?.trim();
  const author = /^[ \t]*Author:[ \t]*"([^"]*)"/m.exec(metadata)?.[1]?.trim();
  header.title = title ? unescapeText(title) : null;
  header.author = author ? unescapeText(author) : null;
  return header;
}

/** Splits ', "a", "b", 1' into ['"a"', '"b"', '1'] (commas inside quotes kept). */
function splitFields(rest: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of rest.replace(/^\s*,/, "")) {
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      fields.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) fields.push(current.trim());
  return fields;
}

/** "cm", "m", "mm", "in", "ft" … for a GlobalSettings UnitScaleFactor (centimetres per unit). */
export function fbxUnits(unitScaleFactor: number | null): string | undefined {
  if (unitScaleFactor === null || !(unitScaleFactor > 0)) return undefined;
  const known: Array<[number, string]> = [
    [1, "cm"],
    [100, "m"],
    [0.1, "mm"],
    [2.54, "in"],
    [30.48, "ft"],
    [91.44, "yd"],
    [100000, "km"],
  ];
  for (const [factor, unit] of known) {
    if (Math.abs(unitScaleFactor - factor) <= factor * 1e-6) return unit;
  }
  return `${Number(unitScaleFactor.toPrecision(6))} cm`;
}
