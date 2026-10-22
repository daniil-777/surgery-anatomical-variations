import { describe, expect, it } from "vitest";
import type { ProjectVersion, VersionKind } from "../../core/types";
import {
  buildVersionHistory,
  canDeleteVersion,
  dayLabel,
  daysUntilExpiry,
  foldAutosaves,
  formatSavedAt,
  isNamedVersion,
  localDaysAgo,
  nextVersionName,
  retentionNote,
  versionKindLabel,
  versionTitle,
} from "./versionHistory";

let counter = 0;
function version(seq: number, kind: VersionKind, createdAt: string, label: string | null = null): ProjectVersion {
  counter += 1;
  return {
    id: `v-${seq}-${counter}`,
    projectId: "p",
    seq,
    parentVersionId: null,
    kind,
    label,
    snapshotAssetId: `s-${seq}`,
    stateSha256: "0".repeat(64),
    thumbnailAssetId: null,
    restoredFromVersionId: null,
    labSchemaVersion: 1,
    appBuild: null,
    byteSize: 10,
    createdAt,
  };
}

// local-time constructors keep the day maths independent of the machine's time zone
const at = (year: number, month: number, day: number, hour = 12, minute = 0) => new Date(year, month - 1, day, hour, minute).toISOString();
const NOW = new Date(2026, 9, 22, 15, 30); // Thursday 22 October 2026, 15:30 local

describe("version labels and titles", () => {
  it("names every kind the way the panel shows it", () => {
    expect(versionKindLabel("autosave")).toBe("Autosave");
    expect(versionKindLabel("manual")).toBe("Saved");
    expect(versionKindLabel("named")).toBe("Named");
    expect(versionKindLabel("restore")).toBe("Restored");
    expect(versionKindLabel("duplicate")).toBe("Copy");
    expect(versionKindLabel("initial")).toBe("Created");
    expect(versionKindLabel("import")).toBe("Imported");
  });

  it("titles named versions by their name and others by number", () => {
    expect(versionTitle({ label: "Liver baseline", seq: 3 })).toBe("Liver baseline");
    expect(versionTitle({ label: "  Spaced  ", seq: 3 })).toBe("Spaced");
    expect(versionTitle({ label: null, seq: 7 })).toBe("Version 7");
    expect(versionTitle({ label: "   ", seq: 4 })).toBe("Version 4");
    expect(isNamedVersion({ label: "   " })).toBe(false);
    expect(nextVersionName(7)).toBe("Version 8");
    expect(nextVersionName(0)).toBe("Version 1");
  });

  it("allows deleting only unnamed versions that are not current", () => {
    expect(canDeleteVersion({ id: "a", label: null }, "b")).toBe(true);
    expect(canDeleteVersion({ id: "a", label: null }, "a")).toBe(false);
    expect(canDeleteVersion({ id: "a", label: "Kept" }, "b")).toBe(false);
  });
});

describe("days", () => {
  it("counts calendar days, not 24-hour spans", () => {
    expect(localDaysAgo(new Date(2026, 9, 21, 23, 59), new Date(2026, 9, 22, 0, 1))).toBe(1);
    expect(localDaysAgo(new Date(2026, 9, 22, 0, 1), new Date(2026, 9, 22, 23, 59))).toBe(0);
  });

  it("labels days like Finder and Photos", () => {
    expect(dayLabel(new Date(2026, 9, 22, 9), NOW)).toBe("Today");
    expect(dayLabel(new Date(2026, 9, 21, 9), NOW)).toBe("Yesterday");
    expect(dayLabel(new Date(2026, 9, 19, 9), NOW)).toBe("Monday");
    expect(dayLabel(new Date(2026, 9, 14, 9), NOW)).toBe("October 14");
    expect(dayLabel(new Date(2025, 11, 3, 9), NOW)).toBe("December 3, 2025");
  });

  it("phrases the last save time", () => {
    expect(formatSavedAt(at(2026, 10, 22, 14, 32), NOW)).toBe("Today at 2:32 PM");
    expect(formatSavedAt(at(2026, 10, 21, 9, 5), NOW)).toBe("Yesterday at 9:05 AM");
    expect(formatSavedAt(at(2026, 10, 14, 11, 0), NOW)).toBe("Oct 14 at 11:00 AM");
    expect(formatSavedAt("not a date", NOW)).toBe("");
  });
});

describe("grouping", () => {
  it("pins the current version and named versions, and groups the rest by day, newest first", () => {
    const versions = [
      version(1, "initial", at(2026, 10, 14, 9)),
      version(2, "autosave", at(2026, 10, 21, 10)),
      version(3, "named", at(2026, 10, 21, 11), "Liver baseline"),
      version(4, "manual", at(2026, 10, 22, 9)),
      version(5, "autosave", at(2026, 10, 22, 10), "Promoted autosave"),
      version(6, "restore", at(2026, 10, 22, 14)),
    ];
    const head = versions[5]!;
    const model = buildVersionHistory(versions, { now: NOW, headVersionId: head.id });
    expect(model.current?.seq).toBe(6);
    expect(model.named.map((item) => item.seq)).toEqual([5, 3]);
    expect(model.days.map((group) => group.label)).toEqual(["Today", "Yesterday", "October 14"]);
    expect(model.days[0]?.rows.map((row) => (row.type === "version" ? row.version.seq : -1))).toEqual([4]);
    expect(model.days[1]?.rows.map((row) => (row.type === "version" ? row.version.seq : -1))).toEqual([2]);
    expect(model.total).toBe(6);
  });

  it("keeps only named versions with the named filter", () => {
    const versions = [version(1, "initial", at(2026, 10, 20)), version(2, "named", at(2026, 10, 21), "A"), version(3, "manual", at(2026, 10, 22))];
    const model = buildVersionHistory(versions, { now: NOW, headVersionId: versions[2]!.id, filter: "named" });
    expect(model.current?.seq).toBe(3);
    expect(model.named.map((item) => item.label)).toEqual(["A"]);
    expect(model.days).toEqual([]);
  });

  it("works without a head (an empty or still-loading project)", () => {
    const model = buildVersionHistory([], { now: NOW, headVersionId: null });
    expect(model).toEqual({ current: null, named: [], days: [], total: 0 });
  });

  it("folds runs of three or more autosaves into one row", () => {
    const run = [
      version(9, "manual", at(2026, 10, 22, 14)),
      version(8, "autosave", at(2026, 10, 22, 13)),
      version(7, "autosave", at(2026, 10, 22, 12)),
      version(6, "autosave", at(2026, 10, 22, 11)),
      version(5, "manual", at(2026, 10, 22, 10)),
      version(4, "autosave", at(2026, 10, 22, 9)),
      version(3, "autosave", at(2026, 10, 22, 8)),
    ];
    const rows = foldAutosaves(run);
    expect(rows.map((row) => (row.type === "version" ? `v${row.version.seq}` : `${row.versions.length} autosaves`))).toEqual([
      "v9",
      "3 autosaves",
      "v5",
      "v4",
      "v3",
    ]);
    expect(foldAutosaves(run, 0).every((row) => row.type === "version")).toBe(true);
  });
});

describe("retention", () => {
  it("never expires the newest five unnamed versions", () => {
    expect(daysUntilExpiry(at(2026, 9, 1), 30, 4, NOW)).toBeNull();
  });

  it("counts the days left in the plan's window", () => {
    expect(daysUntilExpiry(new Date(NOW.getTime() - 27 * 86_400_000).toISOString(), 30, 5, NOW)).toBe(3);
    expect(daysUntilExpiry(new Date(NOW.getTime() - 40 * 86_400_000).toISOString(), 30, 9, NOW)).toBe(0);
    expect(daysUntilExpiry(at(2026, 10, 1), 0, 9, NOW)).toBeNull();
  });

  it("explains the rule in the footer", () => {
    expect(retentionNote(30)).toBe("Unnamed versions are kept for 30 days (the newest five always stay). Named versions are kept until you remove their name.");
    expect(retentionNote(1)).toContain("for 1 day ");
    expect(retentionNote(null)).toBe("Named versions are kept until you remove their name.");
  });
});
