import { describe, expect, it } from "vitest";
import { formatDaysLeft, formatEdited, formatRelative, formatShortDate, greeting, trashDaysLeft } from "./time";

// local wall-clock times, so the expectations hold in any time zone
const at = (month: number, day: number, hour = 12, minute = 0, year = 2026) => new Date(year, month - 1, day, hour, minute).getTime();
const DAY = 24 * 60 * 60 * 1000;

describe("relative times", () => {
  const now = at(10, 22, 21, 30);

  it("counts minutes and hours today, then days, then shows a date", () => {
    expect(formatRelative(now - 20_000, now)).toBe("just now");
    expect(formatRelative(at(10, 22, 21, 25), now)).toBe("5 min ago");
    expect(formatRelative(at(10, 22, 19, 10), now)).toBe("2 h ago");
    expect(formatRelative(at(10, 21, 23, 50), now)).toBe("yesterday");
    expect(formatRelative(at(10, 19, 9), now)).toBe("3 days ago");
    expect(formatRelative(at(10, 3, 9), now)).toBe("Oct 3");
    expect(formatRelative(at(12, 24, 9, 0, 2025), now)).toBe("Dec 24, 2025");
    expect(formatRelative("not a date", now)).toBe("");
  });

  it("says when a project was edited", () => {
    expect(formatEdited(at(10, 22, 19, 10), now)).toBe("Edited 2 h ago");
    expect(formatEdited(new Date(now - 5_000).toISOString(), now)).toBe("Edited just now");
    expect(formatEdited("", now)).toBe("");
  });

  it("formats short dates with the year only when it differs", () => {
    expect(formatShortDate(at(10, 3), now)).toBe("Oct 3");
    expect(formatShortDate(at(10, 3, 12, 0, 2024), now)).toBe("Oct 3, 2024");
  });
});

describe("trash countdown", () => {
  it("counts whole days left of the 30-day window", () => {
    const trashed = at(10, 1, 9);
    expect(trashDaysLeft(trashed, trashed + 1000)).toBe(29);
    expect(trashDaysLeft(trashed, trashed + 10 * DAY)).toBe(20);
    expect(trashDaysLeft(trashed, trashed + 29.5 * DAY)).toBe(0);
    expect(trashDaysLeft(trashed, trashed + 45 * DAY)).toBe(0);
    expect(trashDaysLeft(new Date(trashed).toISOString(), trashed + DAY + 1)).toBe(28);
  });

  it("labels the countdown", () => {
    expect(formatDaysLeft(29)).toBe("29 days");
    expect(formatDaysLeft(1)).toBe("1 day");
    expect(formatDaysLeft(0)).toBe("Less than a day");
  });
});

describe("greeting", () => {
  it("greets by the time of day and the first name", () => {
    expect(greeting("Daniil Emtsev", at(10, 22, 8))).toBe("Good morning, Daniil");
    expect(greeting("Daniil", at(10, 22, 14))).toBe("Good afternoon, Daniil");
    expect(greeting(null, at(10, 22, 21))).toBe("Good evening");
    expect(greeting("  ", at(10, 22, 2))).toBe("Good evening");
  });
});
