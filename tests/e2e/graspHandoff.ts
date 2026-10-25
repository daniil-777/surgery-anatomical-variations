import type { Page } from "@playwright/test";
export async function startHandoffTrace(page: Page) {
  await page.evaluate(() => {
    const w = window as any; w.__handoffSamples = [];
    w.__handoffTimer = setInterval(() => {
      const s = w.__visceraSceneSnapshot();
      w.__handoffSamples.push({ t: performance.now(), camera: s.cameraPlanner?.phase, grasp: s.automaticGrasp?.phase, visible: s.tools?.instrumentVisible });
    }, 25);
  });
}
export async function finishHandoffTrace(page: Page) {
  return page.evaluate(() => {
    const w = window as any; clearInterval(w.__handoffTimer);
    const samples = w.__handoffSamples as { t: number; camera: string; grasp: string; visible: boolean }[];
    const grasp = w.__visceraSceneSnapshot().automaticGrasp;
    const playing = samples.findIndex(s => s.camera === "playing");
    // Physics initialization can invalidate the completed camera map within
    // one frame. The first sample after playback ends bounds the handoff.
    const arrival = playing < 0 ? grasp.timing.startMs : samples.slice(playing).find(s => s.camera !== "playing")?.t;
    const visible = samples.find(s => s.t >= arrival && s.visible)?.t;
    const closing = samples.find(s => s.t >= arrival && s.grasp === "closing")?.t;
    if (arrival === undefined || visible === undefined || closing === undefined) throw new Error("Incomplete handoff trace.");
    return { motionAfterArrivalMs: visible - arrival, contactAfterArrivalMs: closing - arrival, samplingMs: 25, timing: grasp.timing, samples };
  });
}
