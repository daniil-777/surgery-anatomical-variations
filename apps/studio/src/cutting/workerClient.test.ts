import { afterEach, describe, expect, it, vi } from "vitest";
import { CuttingWorkerClient } from "./workerClient";
import type { CuttingOptions, CuttingReference } from "./types";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  onmessageerror?: () => void;
  messages: { id: number; action: string }[] = [];
  terminated = false;
  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: { id: number; action: string }) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  reply(client: CuttingWorkerClient, time: number, accepted = true) {
    this.onmessage?.({ data: { id: this.messages.at(-1)!.id, accepted,
      positionsMm: new Float64Array([time, 0, 0, 0, 0, 0]), damage: new Float64Array([time / 10]),
      dtSeconds: .01, metrics: { ...client.metrics(), timeSeconds: time },
      pose: { tipYMm: 10 - time, centerZMm: 0, active: time > 0 } } });
  }
}
const reference = { positionsMm: [0, 0, 0, 0, 0, 0], seamPairs: [{ left: 0, right: 1, areaM2: 1e-4 }],
  diagnostics: { splitVolumeM3: 1e-6, seamAreaM2: 1e-4 } } as CuttingReference;
const options = { bulk: { density_kg_m3: 1060 }, cohesive: { fractureEnergyJm2: 8, peakTractionPa: 16000 } } as CuttingOptions;
const pose = { tipYMm: 2, centerZMm: 0, active: true };
async function setup() {
  vi.stubGlobal("Worker", FakeWorker);
  const client = new CuttingWorkerClient(reference, options), worker = FakeWorker.instances.at(-1)!;
  worker.reply(client, 0); await client.ready;
  return { client, worker };
}
afterEach(() => { vi.unstubAllGlobals(); FakeWorker.instances = []; });
describe("cutting worker accepted-state bridge", () => {
  it("publishes only a completed step and rejects concurrent numerical requests", async () => {
    const { client, worker } = await setup();
    const pending = client.step(pose); await Promise.resolve();
    expect(client.metrics().timeSeconds).toBe(0);
    await expect(client.step(pose)).rejects.toThrow("already in flight");
    expect(worker.messages.map(m => m.action)).toEqual(["init", "step"]);
    worker.reply(client, .01); await expect(pending).resolves.toBe(true);
    expect(client.metrics().timeSeconds).toBe(.01);
    const m = client.metrics(); m.contactForceN[0] = 999;
    expect(client.metrics().contactForceN[0]).toBe(0);
    client.dispose();
  });
  it("preserves the accepted snapshot on worker failure and restarts on reset", async () => {
    const { client, worker } = await setup();
    const step = client.step(pose); await Promise.resolve();
    worker.onerror?.(); await expect(step).rejects.toThrow("worker stopped");
    expect(client.metrics().timeSeconds).toBe(0);
    await expect(client.step(pose)).rejects.toThrow("worker stopped");
    const reset = client.reset(); const next = FakeWorker.instances.at(-1)!;
    expect(next).not.toBe(worker); expect(worker.terminated).toBe(true);
    next.reply(client, 0); await reset;
    // A late event from the old worker cannot overwrite the new epoch.
    worker.reply(client, 99); expect(client.metrics().timeSeconds).toBe(0);
    client.dispose();
  });
  it("disposal cancels pending work without publishing a newer clock", async () => {
    const { client, worker } = await setup();
    const step = client.step(pose); await Promise.resolve();
    client.dispose(); await expect(step).rejects.toThrow("disposed");
    worker.reply(client, 1); expect(client.metrics().timeSeconds).toBe(0);
    await expect(client.reset()).rejects.toThrow("disposed");
  });
});
