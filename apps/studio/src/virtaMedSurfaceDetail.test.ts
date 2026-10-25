import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { registerSurfacePoint } from "./virtaMedSurfaceDetail";

function square(offset=-100,scale=1,seam=false) {
  const corners=[[offset,40,20],[offset+scale,40,20],[offset,40+scale,20],[offset+scale,40+scale,20]];
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute("position",new THREE.Float32BufferAttribute((seam?[corners[0]!,corners[1]!,corners[2]!,corners[1]!,corners[3]!,corners[2]!]:corners).flat(),3));
  geometry.setAttribute("uv",new THREE.Float32BufferAttribute(seam?[0,0,1,0,0,1,2,0,2,1,1,1]:[0,0,1,0,0,1,1,1],2));
  geometry.setIndex(seam?[0,1,2,3,4,5]:[0,1,2,1,3,2]);return geometry;
}
function areas(geometry:THREE.BufferGeometry) {
  const p=geometry.getAttribute("position"),index=geometry.index!,result:number[]=[];
  for(let face=0;face<index.count;face+=3){const a=new THREE.Vector3().fromBufferAttribute(p,index.getX(face)),b=new THREE.Vector3().fromBufferAttribute(p,index.getX(face+1)),c=new THREE.Vector3().fromBufferAttribute(p,index.getX(face+2));result.push(b.sub(a).cross(c.sub(a)).z/2);}
  return result;
}

describe("precision-aware attachment registration",()=>{
  it.each([-100,-100000])("snaps a near-edge hit at coordinate %s and splits both incident faces without a sliver",offset=>{
    const geometry=square(offset),p=geometry.getAttribute("position"),ulp=2**(Math.floor(Math.log2(Math.abs(offset)))-23);
    const point=registerSurfacePoint(geometry,[offset+.5,40.5+ulp/3,20]);
    expect(geometry.getAttribute("position").count).toBe(p.count+1);
    expect(geometry.index!.count).toBe(12);
    expect(areas(geometry).every(a=>a>.2)).toBe(true);
    expect(areas(geometry).reduce((a,b)=>a+b,0)).toBeCloseTo(1,4);
    const index=geometry.index!,edgeCounts=new Map<string,number>();
    for(let face=0;face<index.count;face+=3)for(let k=0;k<3;k++){const edge=[index.getX(face+k),index.getX(face+(k+1)%3)].sort((a,b)=>a-b).join(":");edgeCounts.set(edge,(edgeCounts.get(edge)??0)+1);}
    expect(edgeCounts.has("1:2")).toBe(false);
    expect(edgeCounts.get("1:4")).toBe(2);expect(edgeCounts.get("2:4")).toBe(2);
    expect(point).toEqual(Array.from(geometry.getAttribute("position").array).slice(-3));geometry.dispose();
  });

  it("reuses a vertex within Float32 uncertainty, keeping its registered coordinate exact",()=>{
    const geometry=square(),positions=geometry.getAttribute("position").array.slice(),index=geometry.index!.array.slice();
    expect(registerSurfacePoint(geometry,[-100+2e-6,40+2e-6,20])).toEqual([-100,40,20]);
    expect(geometry.getAttribute("position").array).toEqual(positions);expect(geometry.index!.array).toEqual(index);geometry.dispose();
  });

  it("splits duplicated UV-seam edges on both sides while preserving separate UV values",()=>{
    const geometry=square(-100,1,true),point=registerSurfacePoint(geometry,[-99.5,40.500003,20]);
    const p=geometry.getAttribute("position"),uv=geometry.getAttribute("uv");
    expect(p.count).toBe(8);expect(geometry.index!.count).toBe(12);
    expect([p.getX(6),p.getY(6),p.getZ(6)]).toEqual(point);expect([p.getX(7),p.getY(7),p.getZ(7)]).toEqual(point);
    expect(Math.abs(uv.getX(6)-uv.getX(7))).toBeCloseTo(1,5);
    expect(areas(geometry).every(a=>a>.2)).toBe(true);geometry.dispose();
  });

  it("retains a true interior insertion and its area instead of snapping meaningful geometry away",()=>{
    const geometry=square(),point=registerSurfacePoint(geometry,[-99.75,40.25,20]);
    expect(point).toEqual([-99.75,40.25,20]);expect(geometry.getAttribute("position").count).toBe(5);
    expect(geometry.index!.count).toBe(12);expect(areas(geometry).every(a=>a>.1)).toBe(true);
    expect(areas(geometry).reduce((a,b)=>a+b,0)).toBeCloseTo(1,7);geometry.dispose();
  });
});
