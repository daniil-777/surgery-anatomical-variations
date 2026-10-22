import { describe, expect, it } from "vitest";
import { busyReasonText, editorStatus, shouldAnnounce, type EditorStatusInput } from "./editorStatus";

const NOW = new Date(2026, 9, 22, 15, 30);
const base: EditorStatusInput = { status: "clean", activity: "idle", waitingFor: null, readonlyReason: null, detached: false, acknowledgementNeeded: false, lastSavedAt: null, localCopy: "saved", error: null };
const view = (patch: Partial<EditorStatusInput>, savingVisible = true) => editorStatus({ ...base, ...patch }, { savingVisible, now: NOW });

describe("editor save status", () => {
  it("says Saved with the time in the tooltip", () => {
    const saved = view({ status: "saved", lastSavedAt: new Date(2026, 9, 22, 14, 32).toISOString() });
    expect(saved).toMatchObject({ text: "Saved", icon: "check", tone: "success", action: null });
    expect(saved.detail).toBe("Saved to your account today at 2:32 PM.");
    expect(view({ status: "clean" })).toMatchObject({ text: "Saved", tone: "neutral" });
  });

  it("says Edited while changes wait and Saving… only after the 400 ms threshold", () => {
    expect(view({ status: "dirty" }).text).toBe("Edited");
    expect(view({ status: "saving" }, false).text).toBe("Edited");
    expect(view({ status: "saving" }, true)).toMatchObject({ text: "Saving…", icon: "spinner" });
  });

  it("keeps offline work honest about where it is", () => {
    expect(view({ status: "offline", localCopy: "saved" })).toMatchObject({ text: "Offline — your changes are kept on this device", icon: "offline", action: "retry" });
    expect(view({ status: "offline", localCopy: "failed" }).text).toBe("Offline — waiting to save");
    expect(view({ status: "offline", localCopy: "off" }).text).toBe("Offline — waiting to save");
  });

  it("offers Edit Here when another tab holds the project", () => {
    expect(view({ status: "readonly", readonlyReason: "locked" })).toMatchObject({ text: "Read-only — open in another tab", icon: "lock", action: "edit-here" });
    expect(view({ status: "readonly", readonlyReason: "trashed" })).toMatchObject({ text: "Read-only — in the Trash", action: "put-back" });
    expect(view({ status: "readonly", readonlyReason: "option" }).action).toBeNull();
  });

  it("names the busy reason while autosave waits for the lab", () => {
    expect(view({ status: "dirty", waitingFor: "recording" }).text).toBe("Autosave paused: recording");
    expect(view({ status: "dirty", busyReason: "running" }).text).toBe("Autosave paused: a simulation is running");
    expect(view({ status: "dirty", activity: "waiting-for-lab", waitingFor: "sculpting" }).text).toBe("Autosave paused: sculpting");
  });

  it("puts conflicts, a lab that left and inexact restores first", () => {
    expect(view({ status: "conflict", waitingFor: "recording" })).toMatchObject({ text: "Changed elsewhere", action: "resolve", tone: "danger" });
    expect(view({ status: "dirty", detached: true })).toMatchObject({ action: "reload-lab" });
    expect(view({ status: "dirty", labLeft: true })).toMatchObject({ action: "reload-lab" });
    expect(view({ status: "saved", acknowledgementNeeded: true })).toMatchObject({ text: "Autosave paused: review the restore", action: "review-restore" });
    expect(view({ status: "saved", awaitingAck: true }).action).toBe("review-restore");
  });

  it("reports a failed save with the reason", () => {
    expect(view({ status: "error", error: { code: "quota_exceeded", message: "Your storage is full." } })).toMatchObject({
      text: "Couldn't save",
      detail: "Your storage is full.",
      action: "retry",
    });
    expect(view({ status: "error", failure: { code: "x", message: "" } }).detail).toBe("The last save did not complete.");
  });

  it("shows opening and restoring as progress", () => {
    expect(view({ status: "clean", activity: "reloading" }).text).toBe("Opening…");
    expect(view({ status: "saving", activity: "restoring" }).text).toBe("Restoring…");
    expect(view({ status: "dirty", activity: "recovering" }).text).toBe("Recovering…");
  });

  it("words busy reasons", () => {
    expect(busyReasonText("loading")).toBe("the lab is loading");
    expect(busyReasonText("  ")).toBe("the lab is busy");
    expect(busyReasonText("Sculpting")).toBe("sculpting");
  });

  it("announces only meaningful transitions", () => {
    const saved = view({ status: "saved" });
    const offline = view({ status: "offline" });
    expect(shouldAnnounce(saved, offline)).toBe(true);
    expect(shouldAnnounce(offline, offline)).toBe(false);
    expect(shouldAnnounce(offline, view({ status: "dirty" }))).toBe(false);
    expect(shouldAnnounce(null, view({ status: "error" }))).toBe(true);
  });
});
