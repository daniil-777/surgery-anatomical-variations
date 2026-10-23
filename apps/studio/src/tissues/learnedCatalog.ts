import type { TissueEntry } from "./contracts";

export const AUTHORED_GROUP = "Authored library";

/** Family key of an entry: declared by learned entries, otherwise the authored id itself. */
export function entryFamily(entry: TissueEntry): string {
  return entry.family ?? entry.id;
}

export function isLearnedEntry(entry: TissueEntry): boolean {
  return entry.group !== undefined && entry.group !== AUTHORED_GROUP;
}

/** Authored studies first, then each learned group in catalog order; entries keep their catalog order. */
export function catalogGroups(entries: readonly TissueEntry[]): { label: string; entries: TissueEntry[] }[] {
  const groups = new Map<string, TissueEntry[]>([[AUTHORED_GROUP, []]]);
  for (const entry of entries) {
    const label = entry.group ?? AUTHORED_GROUP;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(entry);
  }
  return [...groups].filter(([, items]) => items.length).map(([label, items]) => ({ label, entries: items }));
}

export function learnedForFamily(entries: readonly TissueEntry[], family: string | undefined): TissueEntry[] {
  if (!family) return [];
  return entries.filter(entry => isLearnedEntry(entry) && entryFamily(entry) === family);
}

/** "Liver capsule · learned pilot-ext · seed 3" → "seed 3"; a short label for gallery tiles. */
export function shortLearnedLabel(entry: TissueEntry): string {
  const seed = /seed (\d+)/.exec(entry.label)?.[1];
  return seed ? `seed ${seed}` : entry.label;
}
