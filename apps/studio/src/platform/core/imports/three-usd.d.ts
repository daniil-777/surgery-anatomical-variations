// Types for the USD crate parser shipped with three.js r186 (examples/jsm/loaders/usd/USDCParser.js), which
// @types/three does not describe. Only the call used by imports/usd.ts is declared.

declare module "three/examples/jsm/loaders/usd/USDCParser.js" {
  export interface UsdcSpec {
    specType: number;
    fields: Record<string, unknown>;
  }

  export class USDCParser {
    parseData(buffer: ArrayBuffer): { specsByPath: Record<string, UsdcSpec | undefined> };
  }
}
