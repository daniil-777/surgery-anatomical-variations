/** Millimetre collision envelopes in the generic instrument's local coordinates.
 * +Z points from the nominal distal contact to the handle. These convex capsules
 * contain the articulated working metal; the proximal grip/collar is excluded.
 */
export interface InstrumentContactEnvelope {
  label: string;
  kind: "shaft" | "jaw";
  startMm: [number, number, number];
  endMm: [number, number, number];
  radiusMm: number;
  allowContactPatch: boolean;
}
export function instrumentContactEnvelopes(mode: "push" | "grasp", probeRadiusMm: number, jawClosure: number): InstrumentContactEnvelope[] {
  const offset = mode === "push" ? Math.max(0, probeRadiusMm * 2 + 9 - 30) : 0;
  const envelopes: InstrumentContactEnvelope[] = [
    { label: mode === "push" ? "probe-neck-and-shaft" : "working-shaft", kind: "shaft", startMm: [0, 0, mode === "push" ? probeRadiusMm * 1.78 : 30], endMm: [0, 0, 240 + offset], radiusMm: 2.75, allowContactPatch: false },
    { label: "proximal-steel-transition", kind: "shaft", startMm: [0, 0, 237 + offset], endMm: [0, 0, 245 + offset], radiusMm: 4.05, allowContactPatch: false },
  ];
  if (mode === "grasp") {
    envelopes.push({ label: "distal-clevis", kind: "shaft", startMm: [0, 0, 17], endMm: [0, 0, 33], radiusMm: 3.2, allowContactPatch: false });
    const closure = Math.min(1, Math.max(0, jawClosure));
    for (const side of [-1, 1]) {
      const angle = -side * (1 - closure) * .43, cos = Math.cos(angle), sin = Math.sin(angle);
      const point = (z: number): [number, number, number] => [side * .55 + side * .56 * cos + z * sin, 0, 18.5 - side * .56 * sin + z * cos];
      envelopes.push({ label: side < 0 ? "left-articulated-jaw" : "right-articulated-jaw", kind: "jaw", startMm: point(.7), endMm: point(-18.5), radiusMm: 3.2, allowContactPatch: true });
    }
  }
  return envelopes;
}
