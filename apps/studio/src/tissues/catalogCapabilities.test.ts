import { describe, expect, it } from "vitest";
import { nativeTissueAvailable, validateEntry } from "./contracts";

const local = { id: "liver", label: "Liver", luminal: false, manifest: "liver/native/manifest.json", preview: "liver/preview/manifest.json" };
describe("tissue distribution capabilities", () => {
  it("preserves the native local catalog and accepts an explicitly preview-only public entry", () => {
    expect(nativeTissueAvailable(validateEntry(local))).toBe(true);
    const preview = validateEntry({ ...local, manifest: null, available_resolutions: [512] });
    expect(nativeTissueAvailable(preview)).toBe(false);
    expect(preview.preview).toBe(local.preview);
  });
  it("rejects ambiguous missing native assets and contradictory or unsupported resolutions", () => {
    for (const available_resolutions of [undefined, [4096], [512, 4096], [], [512, 512], [512, 2048], "512"]) {
      expect(() => validateEntry({ ...local, manifest: null, available_resolutions })).toThrow();
    }
    expect(() => validateEntry({ ...local, manifest: undefined, available_resolutions: [512] })).toThrow();
    expect(() => validateEntry({ ...local, preview: "../manifest.json", manifest: null, available_resolutions: [512] })).toThrow();
  });
});
