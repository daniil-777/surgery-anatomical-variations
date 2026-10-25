import { describe,expect,it } from "vitest";
import * as THREE from "three";
import { updateSceneBounds,updateSceneNormals } from "./sceneSurfaceUpdate";

describe("packed current-surface updates",()=>{
  it("does not write floating normals into quantized integer storage",()=>{
    const geometry=new THREE.TorusGeometry(20,6,12,24),reference=geometry.clone();reference.computeVertexNormals();
    geometry.setAttribute("normal",new THREE.BufferAttribute(new Int16Array(geometry.getAttribute("position").count*3),3,true));
    updateSceneNormals(geometry,false);
    expect(geometry.getAttribute("normal").array).toBeInstanceOf(Float32Array);
    const actual=geometry.getAttribute("normal").array,expected=reference.getAttribute("normal").array;
    for(let i=0;i<actual.length;i++)expect(actual[i]).toBeCloseTo(expected[i]!,6);
  });
  it("agrees with geometric corner-angle normals on an irregular deformed surface",()=>{
    const geometry=new THREE.SphereGeometry(17,39,23).scale(1.7,.5,1.1),p=geometry.getAttribute("position"),index=geometry.index!;
    for(let i=0;i<p.count;i++)p.setZ(i,p.getZ(i)+Math.sin(p.getX(i)*.2)*2);
    const sums=Array.from({length:p.count},()=>new THREE.Vector3());
    for(let f=0;f<index.count;f+=3){
      const ids=[index.getX(f),index.getX(f+1),index.getX(f+2)],v=ids.map(i=>new THREE.Vector3().fromBufferAttribute(p,i));
      const n=v[1]!.clone().sub(v[0]!).cross(v[2]!.clone().sub(v[0]!));if(n.length()<1e-12)continue;n.normalize();
      for(let c=0;c<3;c++){const u=v[(c+1)%3]!.clone().sub(v[c]!),w=v[(c+2)%3]!.clone().sub(v[c]!);sums[ids[c]!]!.addScaledVector(n,Math.atan2(u.clone().cross(w).length(),u.dot(w)));}
    }
    updateSceneNormals(geometry);const normal=geometry.getAttribute("normal");
    for(let i=0;i<p.count;i++)if(sums[i]!.length()>1e-12)expect(new THREE.Vector3().fromBufferAttribute(normal,i).distanceTo(sums[i]!.normalize())).toBeLessThan(3e-7);
    // Repeated use must clear scratch accumulators and use the current surface.
    geometry.rotateY(.4);updateSceneNormals(geometry);const once=normal.array.slice();updateSceneNormals(geometry);expect(normal.array).toEqual(once);
  });
  it("matches area-weighted normals and keeps all vertices inside current bounds",()=>{
    const geometry=new THREE.TorusGeometry(20,6,17,47),reference=geometry.clone();reference.computeVertexNormals();updateSceneNormals(geometry,false);
    const actual=geometry.getAttribute("normal").array,expected=reference.getAttribute("normal").array;
    for(let i=0;i<actual.length;i++)expect(actual[i]).toBeCloseTo(expected[i]!,6);
    geometry.translate(102,-4,27);reference.translate(102,-4,27);reference.computeBoundingBox();updateSceneBounds(geometry);
    expect(geometry.boundingBox).toEqual(reference.boundingBox);
    const p=geometry.getAttribute("position"),point=new THREE.Vector3();for(let i=0;i<p.count;i++)expect(geometry.boundingSphere!.containsPoint(point.fromBufferAttribute(p,i))).toBe(true);
  });
});
