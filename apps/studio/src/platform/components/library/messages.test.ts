import { describe, expect, it } from "vitest";
import { PlatformError } from "../../core/types";
import { errorCode, isSilentError, libraryErrorMessage, tagProblem, titleProblem } from "./messages";

describe("library messages", () => {
  it("names the file and the plan limit for upload failures", () => {
    expect(libraryErrorMessage(new PlatformError("quota_exceeded"), "upload", { name: "Liver.glb" })).toBe(
      "There isn’t enough storage left for “Liver.glb”. Delete items you no longer need or empty the Trash.",
    );
    expect(libraryErrorMessage(new PlatformError("file_too_large"), "upload", { name: "big.mp4", maxFileBytes: 52_428_800 })).toBe(
      "“big.mp4” is larger than your plan allows (52.4 MB per file).",
    );
    expect(libraryErrorMessage(new PlatformError("file_too_large"), "upload", { name: "big.mp4" })).toBe("“big.mp4” is larger than your plan allows.");
    expect(libraryErrorMessage(new PlatformError("network"), "upload", { name: "a.png" })).toMatch(/^Couldn’t upload “a.png”\. .*can’t reach the server/);
    expect(libraryErrorMessage(new PlatformError("size_mismatch"), "upload", { name: "a.png" })).toMatch(/^Couldn’t upload “a.png”\. /);
    expect(libraryErrorMessage(new PlatformError("aborted"), "upload", { name: "a.png" })).toBe("The upload of “a.png” was cancelled.");
  });

  it("covers the other actions without codes or blame", () => {
    expect(libraryErrorMessage(new PlatformError("not_found"), "download", { name: "a.png" })).toBe("Couldn’t download “a.png”. This item no longer exists.");
    expect(libraryErrorMessage(new PlatformError("invalid_input"), "update")).toMatch(/^Couldn’t save the change\. /);
    expect(libraryErrorMessage(new PlatformError("not_authenticated"), "trash", { name: "Liver" })).toBe(
      "Couldn’t move “Liver” to the Trash. Your session has ended. Sign in again to continue.",
    );
    expect(libraryErrorMessage(new Error("boom"), "load")).toBe("Something went wrong. Try again.");
    for (const code of ["unknown", "network", "quota_exceeded", "rate_limited", "asset_busy"] as const) {
      for (const action of ["load", "upload", "update", "trash", "restore", "download", "preview"] as const) {
        const message = libraryErrorMessage(new PlatformError(code), action, { name: "x.png" });
        expect(message).not.toMatch(/error|PT\d|_/i);
        expect(message.endsWith(".")).toBe(true);
      }
    }
  });

  it("recognises errors by shape and stays quiet for cancellations", () => {
    expect(errorCode({ name: "PlatformError", code: "network" })).toBe("network");
    expect(errorCode({ name: "AbortError" })).toBe("aborted");
    expect(isSilentError({ name: "AbortError" })).toBe(true);
    expect(isSilentError(new PlatformError("network"))).toBe(false);
  });

  it("checks titles and tags before saving", () => {
    expect(titleProblem("  ")).toBe("Enter a name.");
    expect(titleProblem("x".repeat(121))).toBe("Use 120 characters or fewer.");
    expect(titleProblem("Liver")).toBeNull();
    expect(tagProblem("", [])).toBeNull();
    expect(tagProblem("wet", ["Wet"])).toBe("“wet” is already a tag.");
    expect(tagProblem("x".repeat(33), [])).toBe("Tags can have at most 32 characters.");
    expect(tagProblem("new", Array.from({ length: 20 }, (_, index) => `t${index}`))).toBe("An item can have at most 20 tags.");
    expect(tagProblem("a\u0007", [])).toBe("Tags can’t contain control characters.");
    expect(tagProblem("liver", ["wet"])).toBeNull();
  });
});
