import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ANATOMY_WHISTLE_KEYWORDS,
  WhistleMicButton,
  cleanWhistleTranscript,
  parseWavToFloat32,
  resampleTo16k,
  whistleState,
} from "./whistleMic";

function makeTestWav16BitMono(samples: number[], sampleRate = 16000): ArrayBuffer {
  const numSamples = samples.length;
  const buf = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 1 channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);
  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  return buf;
}

describe("Cactus Whistle speech-to-text utilities", () => {
  it("exposes Cactus-Compute/whistle metadata and anatomy keywords", () => {
    expect(whistleState.model).toBe("Cactus-Compute/whistle");
    expect(whistleState.engine).toBe("Cactus-Compute/needle3");
    expect(whistleState.sampleRate).toBe(16000);
    expect(ANATOMY_WHISTLE_KEYWORDS).toContain("liver");
    expect(ANATOMY_WHISTLE_KEYWORDS).toContain("wider");
    expect(ANATOMY_WHISTLE_KEYWORDS).toContain("wetter");
  });

  it("resamples arbitrary sample rates cleanly to 16 kHz mono Float32Array", () => {
    const src48k = new Float32Array(4800);
    for (let i = 0; i < src48k.length; i++) {
      src48k[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    }
    const out16k = resampleTo16k(src48k, 48000);
    expect(out16k.length).toBe(1600);
    let maxAbs = 0;
    for (let i = 0; i < out16k.length; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(out16k[i]!));
    }
    expect(maxAbs).toBeGreaterThan(0.9);
    expect(maxAbs).toBeLessThanOrEqual(1.0);
  });

  it("parses a 16-bit PCM WAV buffer into a 16 kHz Float32Array", () => {
    const input = [0, 0.25, 0.5, -0.5, -0.25, 0];
    const wav = makeTestWav16BitMono(input, 16000);
    const parsed = parseWavToFloat32(wav);
    expect(parsed.length).toBe(input.length);
    expect(parsed[2]).toBeCloseTo(0.5, 2);
    expect(parsed[3]).toBeCloseTo(-0.5, 2);
  });

  it("normalizes and cleans raw Whistle transcripts for 3D shape prompts", () => {
    expect(cleanWhistleTranscript("  Make the liver wider and wetter.  ")).toBe(
      "Make the liver wider and wetter",
    );
    expect(cleanWhistleTranscript("A Red Sports Car!", true)).toBe("a red sports car");
  });

  it("renders WhistleMicButton markup with accessible label and phase attributes", () => {
    const onTranscript = vi.fn();
    const html = renderToStaticMarkup(<WhistleMicButton onTranscript={onTranscript} disabled={false} />);
    expect(html).toContain('aria-label="Voice to 3D shape"');
    expect(html).toContain('data-phase="idle"');
    expect(html).toContain('data-testid="whistle-mic-button"');
  });
});

