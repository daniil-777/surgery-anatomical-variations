import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatCount,
  formatDuration,
  formatPercent,
  formatUsage,
  iconStrokeWidth,
  initials,
  storageFraction,
  storageLevel,
} from "./format";

describe("formatBytes", () => {
  it("uses decimal units like Finder", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1)).toBe("1 byte");
    expect(formatBytes(999)).toBe("999 bytes");
    expect(formatBytes(1000)).toBe("1 KB");
    expect(formatBytes(512_000)).toBe("512 KB");
    expect(formatBytes(3_200_000_000)).toBe("3.2 GB");
    expect(formatBytes(12_440_000)).toBe("12.4 MB");
    expect(formatBytes(50 * 1000 ** 3)).toBe("50 GB");
    expect(formatBytes(2.5 * 1000 ** 4)).toBe("2.5 TB");
  });

  it("carries rounding into the next unit", () => {
    expect(formatBytes(999_960)).toBe("1 MB");
    expect(formatBytes(999_499)).toBe("999 KB");
  });

  it("groups digits through Intl and refuses nonsense", () => {
    expect(formatBytes(1_500_000_000_000_000_000)).toBe("1,500 PB");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(3_200_000_000, "de-DE")).toBe("3,2 GB");
  });
});

describe("storage", () => {
  it("shares the unit when it can", () => {
    expect(formatUsage(3_200_000_000, 50_000_000_000)).toBe("3.2 of 50 GB");
    expect(formatUsage(312_000_000, 50_000_000_000)).toBe("312 MB of 50 GB");
    expect(formatUsage(0, 500_000_000)).toBe("0 bytes of 500 MB");
  });

  it("computes fraction and warning levels", () => {
    expect(storageFraction(250, 1000)).toBe(0.25);
    expect(storageFraction(2000, 1000)).toBe(1);
    expect(storageFraction(10, 0)).toBe(0);
    expect(storageLevel(899, 1000)).toBe("normal");
    expect(storageLevel(900, 1000)).toBe("warning");
    expect(storageLevel(1000, 1000)).toBe("full");
    expect(storageLevel(5, 0)).toBe("normal");
  });
});

describe("counts, durations, percentages", () => {
  it("pluralises Title Case nouns", () => {
    expect(formatCount(1, "Item")).toBe("1 Item");
    expect(formatCount(1284, "Item")).toBe("1,284 Items");
    expect(formatCount(0, "Project")).toBe("0 Projects");
    expect(formatCount(2, "Copy", "Copies")).toBe("2 Copies");
  });

  it("formats durations", () => {
    expect(formatDuration(42)).toBe("0:42");
    expect(formatDuration(725)).toBe("12:05");
    expect(formatDuration(3723)).toBe("1:02:03");
    expect(formatDuration(-5)).toBe("0:00");
  });

  it("formats percentages", () => {
    expect(formatPercent(0.424)).toBe("42%");
    expect(formatPercent(2)).toBe("100%");
  });
});

describe("initials", () => {
  it("uses the first and last word", () => {
    expect(initials("Daniil Emtsev")).toBe("DE");
    expect(initials("ada lovelace byron")).toBe("AB");
    expect(initials("Daniil")).toBe("D");
    expect(initials("daniil.emtsev@example.com")).toBe("D");
    expect(initials("  ")).toBe("?");
    expect(initials(null)).toBe("?");
  });
});

describe("icons", () => {
  it("thins strokes for large glyphs", () => {
    expect(iconStrokeWidth(12)).toBe(1.75);
    expect(iconStrokeWidth(17)).toBe(1.75);
    expect(iconStrokeWidth(20)).toBe(1.5);
    expect(iconStrokeWidth(44)).toBe(1.5);
  });
});
