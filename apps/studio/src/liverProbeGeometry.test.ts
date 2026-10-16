import { describe, expect, it } from "vitest";
import { closestTrianglePoint, type Point3 } from "./liverProbeGeometry";
const a: Point3 = [0, 0, 0], b: Point3 = [.05, 0, 0], c: Point3 = [0, .05, 0];
describe("exact sphere/triangle contact geometry", () => {
  it("resolves interior, edge, vertex and degenerate features with normalized barycentric coordinates", () => {
    for (const p of [[.01,.02,.006],[.04,.04,.006],[-.02,-.01,.006]] as Point3[]) {
      const q = closestTrianglePoint(p,a,b,c); expect(q.weights.reduce((x,y)=>x+y,0)).toBeCloseTo(1,12); expect(Math.min(...q.weights)).toBeGreaterThanOrEqual(0);
      for(let k=0;k<3;k++) expect(q.point[k]).toBeCloseTo(q.weights[0]*a[k]!+q.weights[1]*b[k]!+q.weights[2]*c[k]!,12);
    }
    expect(closestTrianglePoint([.01,.02,.006],a,b,c).distance).toBeCloseTo(.006,12);
    expect(closestTrianglePoint([.03,.01,0],a,b,b).point[0]).toBeCloseTo(.03,14);
    expect(closestTrianglePoint([.03,.01,0],a,a,a).point).toEqual([0,0,0]);
  });
  it("has the envelope-theorem nodal gradient on face, edge and vertex features", () => {
    for(const p of [[.01,.02,.009],[.04,.04,.009],[-.02,-.01,.009]] as Point3[]) {
      const vertices: [[number,number,number],[number,number,number],[number,number,number]] = [[...a],[...b],[...c]], q=closestTrianglePoint(p,...vertices);
      for(let node=0;node<3;node++)for(let k=0;k<3;k++) {
        const old=vertices[node]![k]!,h=1e-8;vertices[node]![k]=old+h;const hi=closestTrianglePoint(p,...vertices).distance;vertices[node]![k]=old-h;const lo=closestTrianglePoint(p,...vertices).distance;vertices[node]![k]=old;
        expect((hi-lo)/(2*h)).toBeCloseTo(q.weights[node]!*(q.point[k]!-p[k]!)/q.distance,7);
      }
    }
  });
  it("keeps exact gap continuous while a sphere crosses a shared triangle edge", () => {
    const d: Point3=[.05,.05,0];
    for(let i=0;i<=200;i++) { const p:Point3=[.025+(i-100)*.0002,.025,.006];const q1=closestTrianglePoint(p,a,b,c),q2=closestTrianglePoint(p,b,d,c);expect(Math.min(q1.distance,q2.distance)).toBeCloseTo(.006,12); }
  });
});
