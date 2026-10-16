import type { SceneData } from '@viscera/render';

export type SurfaceEdit = { organ_id: string; positions: number[] };
export interface SculptHistory { past: SurfaceEdit[][]; present: SurfaceEdit[]; future: SurfaceEdit[][] }
export const emptySculptHistory = (): SculptHistory => ({ past: [], present: [], future: [] });
const MAX_STROKES = 20;

/** Snapshots own their arrays: brush scratch buffers cannot mutate undo states. */
export function commitSculpt(history: SculptHistory, edit: SurfaceEdit): SculptHistory {
  const previous = history.present.find(item => item.organ_id === edit.organ_id);
  if (previous && previous.positions.length === edit.positions.length && previous.positions.every((v, i) => v === edit.positions[i])) return history;
  const present = history.present.filter(item => item.organ_id !== edit.organ_id);
  present.push({ organ_id: edit.organ_id, positions: [...edit.positions] });
  return { past: [...history.past, history.present].slice(-MAX_STROKES), present, future: [] };
}
export function undoSculpt(history: SculptHistory): SculptHistory {
  const present = history.past.at(-1);
  return present ? { past: history.past.slice(0, -1), present, future: [history.present, ...history.future] } : history;
}
export function redoSculpt(history: SculptHistory): SculptHistory {
  const present = history.future[0];
  return present ? { past: [...history.past, history.present].slice(-MAX_STROKES), present, future: history.future.slice(1) } : history;
}
export function applySculptEdits(scene: SceneData, edits: SurfaceEdit[]): SceneData {
  if (!edits.length) return scene;
  return { ...scene, organs: scene.organs.map(organ => {
    const edit = edits.find(item => item.organ_id === organ.id);
    if (!edit || edit.positions.length !== organ.positions.length) return organ;
    const { normals: _normals, ...rest } = organ;
    return { ...rest, positions: edit.positions, sculpt_reference_positions: organ.positions, rest_positions: (organ as typeof organ & { rest_positions?: number[] }).rest_positions ?? organ.positions };
  }) };
}
