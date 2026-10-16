import { describe, expect, it } from 'vitest';
import { applySculptEdits, commitSculpt, emptySculptHistory, redoSculpt, undoSculpt } from './atlasSculptHistory';
describe('surface sculpt history', () => {
  it('owns mutable brush output and restores exact edits through undo/redo', () => {
    const positions = [1, 2, 3];
    const first = commitSculpt(emptySculptHistory(), { organ_id: 'liver', positions });
    positions[0] = 99;
    const second = commitSculpt(first, { organ_id: 'liver', positions });
    expect(undoSculpt(second).present[0]!.positions).toEqual([1, 2, 3]);
    expect(redoSculpt(undoSculpt(second)).present).toEqual(second.present);
    expect(undoSculpt(first).present).toEqual([]);
    expect(commitSculpt(undoSculpt(second), {organ_id:'liver', positions:[4,5,6]}).future).toEqual([]);
  });
  it('preserves template material coordinates and drops stale normals', () => {
    const source = { organs: [{ id:'liver', name:'Liver', kind:'organ', color:'#fff', positions:[1,2,3], normals:[0,0,1], indices:[0,0,0] }] };
    const scene = applySculptEdits(source, [{organ_id:'liver',positions:[4,5,6]}]);
    expect(scene.organs[0]).toMatchObject({positions:[4,5,6],rest_positions:[1,2,3]});
    expect(scene.organs[0]!.normals).toBeUndefined();
    expect(source.organs[0]!.positions).toEqual([1,2,3]);
  });
});
