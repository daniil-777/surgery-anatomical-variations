export const EXPERIMENTS = [
  {
    id: "tank-rest", family: "tank", number: "01", title: "Still tank",
    description: "Check that a level pool stays level and conserves its volume.",
    protocol: "Run the untouched tank first. The free surface should remain stationary; camera movement must not change the fluid.",
  },
  {
    id: "tank-impact", family: "tank", number: "02", title: "Object impact",
    description: "Drop a sphere or cube and observe displacement, waves and buoyancy.",
    protocol: "Choose an object, drop it, then run. Compare its settling motion and the reflected waves at the same physical time. Reset before dropping another object.",
  },
  {
    id: "tank-wave", family: "tank", number: "03", title: "Viscosity & waves",
    description: "Release a small standing wave and compare its decay.",
    protocol: "Run the same initial wave with different viscosities. Keep observations at equal physical times; numerical damping also contributes to decay.",
  },
  {
    id: "artery-puncture", family: "vessel", number: "04", title: "Arterial puncture",
    description: "Couple cardiovascular pressure to jets, drops and local impacts.",
    protocol: "Run the cardiovascular reference, open a puncture and compare the arterial-pressure trace with the outflow. Inspect necking, separated drops and local collection. Occluding a site stops new blood loss while emitted blood continues moving. Select laboratory supply for prescribed-pressure comparisons.",
  },
  {
    id: "vein-puncture", family: "vessel", number: "05", title: "Venous puncture",
    description: "Compare lower-pressure leakage with the arterial experiment.",
    protocol: "A large upstream microvascular resistance places this segment near venous pressure in the same systemic circulation. Compare it with the arterial trial at equal physical times and hole sizes. The interface reports low-speed flow outside the current breakup approximation.",
  },
] as const;
export type ExperimentId = typeof EXPERIMENTS[number]["id"];
export const experimentById = (id: string | null) => EXPERIMENTS.find(item => item.id === id) ?? EXPERIMENTS[1]!;

/** JSON evidence must preserve the numerical arrays, including nested parcels. */
export function evidenceJSON(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    ArrayBuffer.isView(item) && !(item instanceof DataView) ? Array.from(item as unknown as ArrayLike<number>) : item, 2);
}
