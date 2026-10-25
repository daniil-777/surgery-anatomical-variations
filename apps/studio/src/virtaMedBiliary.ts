import * as THREE from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { registerSurfacePoint, surfaceFor } from "./virtaMedSurfaceDetail";

type V3 = [number, number, number];
export const BILIARY_JUNCTION: V3 = [-2, -24, -16];
export const BILIARY_PATHS: Record<string, V3[]> = {
  "cystic-duct": [[-47,-10,-10],[-40,-12,-18],[-33,-15,-23],[-20,-20,-22],[-9,-23,-18],BILIARY_JUNCTION],
  "hepatic-duct": [[-8,56,-31],[-6,18,-26],[-4,-10,-21],BILIARY_JUNCTION,[13,-42,-24],[37,-57,-27]],
};

/** One closed swept solid, partitioned into anatomical labels only AFTER its
 * Y junction is formed. The two label boundaries share identical coordinates;
 * no capped branch protrudes into another tube and no lumen is exposed. This
 * is an authored external envelope, not a resolved internal biliary lumen. */
export function createBiliaryEnvelope(resolution = 128) {
  const lo = new THREE.Vector3(-55,-66,-43), hi = new THREE.Vector3(46,65,0), size = hi.clone().sub(lo);
  const paths = Object.entries(BILIARY_PATHS).map(([id, points]) => {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
    const samples = curve.getSpacedPoints(96);
    return { id, radius: id === "cystic-duct" ? 2.85 : 3.45, samples };
  });
  const fields = paths.map(() => new Float32Array(resolution ** 3).fill(-100));
  for (const [part, path] of paths.entries()) for (let s=1;s<path.samples.length;s++) {
    const a=path.samples[s-1]!,b=path.samples[s]!,axis=b.clone().sub(a),length2=axis.lengthSq(),support=path.radius+3;
    const min=a.clone().min(b).addScalar(-support).sub(lo).divide(size).multiplyScalar(resolution).floor().max(new THREE.Vector3(1,1,1));
    const max=a.clone().max(b).addScalar(support).sub(lo).divide(size).multiplyScalar(resolution).ceil().min(new THREE.Vector3(resolution-2,resolution-2,resolution-2));
    for(let z=min.z;z<=max.z;z++)for(let y=min.y;y<=max.y;y++)for(let x=min.x;x<=max.x;x++){
      const px=lo.x+size.x*x/resolution-a.x,py=lo.y+size.y*y/resolution-a.y,pz=lo.z+size.z*z/resolution-a.z;
      const t=THREE.MathUtils.clamp((px*axis.x+py*axis.y+pz*axis.z)/length2,0,1);
      const value=path.radius-Math.hypot(px-axis.x*t,py-axis.y*t,pz-axis.z*t),i=z*resolution*resolution+y*resolution+x;
      fields[part]![i]=Math.max(fields[part]![i]!,value);
    }
  }
  const mc=new MarchingCubes(resolution,new THREE.MeshBasicMaterial(),false,false,180000);mc.isolation=0;
  for(let i=0;i<mc.field.length;i++){const a=fields[0]![i]!,b=fields[1]![i]!,h=Math.max(1.6-Math.abs(a-b),0)/1.6;mc.field[i]=Math.max(a,b)+h*h*.4;}
  mc.update();const source=new THREE.BufferGeometry();
  source.setAttribute("position",new THREE.BufferAttribute((mc.geometry.getAttribute("position").array as Float32Array).slice(0,mc.geometry.drawRange.count*3),3));
  source.scale(size.x/2,size.y/2,size.z/2);source.translate((lo.x+hi.x)/2,(lo.y+hi.y)/2,(lo.z+hi.z)/2);
  const welded=mergeVertices(source,.00001);source.dispose();mc.geometry.dispose();(mc.material as THREE.Material).dispose();
  const p=welded.getAttribute("position"),indices=welded.index!,output=paths.map(()=>({positions:[] as number[],uv:[] as number[],indices:[] as number[],map:new Map<number,number>()}));
  const score=(point:THREE.Vector3,path:typeof paths[number])=>{
    let distance=Infinity;const closest=new THREE.Vector3();
    for(let s=1;s<path.samples.length;s++){new THREE.Line3(path.samples[s-1]!,path.samples[s]!).closestPointToPoint(point,true,closest);distance=Math.min(distance,point.distanceTo(closest));}
    return distance-path.radius;
  };
  for(let f=0;f<indices.count;f+=3){
    const ids=[indices.getX(f),indices.getX(f+1),indices.getX(f+2)],a=new THREE.Vector3().fromBufferAttribute(p,ids[0]!),b=new THREE.Vector3().fromBufferAttribute(p,ids[1]!),c=new THREE.Vector3().fromBufferAttribute(p,ids[2]!);
    if(ids[0]===ids[1]||ids[1]===ids[2]||ids[2]===ids[0])continue;
    const center=a.add(b).add(c).multiplyScalar(1/3),owner=score(center,paths[0]!)<score(center,paths[1]!)?0:1,o=output[owner]!;
    for(const id of ids){let index=o.map.get(id);if(index===undefined){index=o.positions.length/3;o.map.set(id,index);o.positions.push(p.getX(id),p.getY(id),p.getZ(id));o.uv.push((p.getX(id)-lo.x)/size.x,(p.getY(id)-lo.y)/size.y);}o.indices.push(index);}
  }
  const roots:V3[]=[];for(const id of output[0]!.map.keys())if(output[1]!.map.has(id))roots.push([p.getX(id),p.getY(id),p.getZ(id)]);
  const result=Object.fromEntries(output.map((o,i)=>{const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(o.positions,3));g.setAttribute("uv",new THREE.Float32BufferAttribute(o.uv,2));g.setIndex(o.indices);g.computeVertexNormals();return [paths[i]!.id,g];})) as Record<string,THREE.BufferGeometry>;
  result["cystic-duct"]!.userData.attachments=[{host:"hepatic-duct",points:roots}];
  result["cystic-duct"]!.userData.junction={method:"single swept implicit envelope with shared label boundary",roots:roots.length,center:BILIARY_JUNCTION};
  welded.dispose();return result;
}

/** Register the existing gallbladder neck against the continuous duct surface.
 * Blend only the final seven neck rings; the fundus/body silhouette is retained. */
export function registerBiliaryNeck(gallbladder:THREE.BufferGeometry,duct:THREE.BufferGeometry,sides=64) {
  const p=gallbladder.getAttribute("position"),start=p.count-sides-1,surface=surfaceFor("duct",duct),points:V3[]=[];
  for(let j=0;j<sides;j++){
    const k=start+j,old:V3=[p.getX(k),p.getY(k),p.getZ(k)],hit=surface.closestPoint(old)!;
    const target=registerSurfacePoint(duct,hit.pointMm);points.push(target);
    for(let ring=0;ring<7;ring++){const i=k-ring*(sides+1),t=ring/7,w=1-t*t*(3-2*t);p.setXYZ(i,p.getX(i)+(target[0]-old[0])*w,p.getY(i)+(target[1]-old[1])*w,p.getZ(i)+(target[2]-old[2])*w);}
  }
  for(let ring=0;ring<7;ring++){const a=start-ring*(sides+1),b=a+sides;p.setXYZ(b,p.getX(a),p.getY(a),p.getZ(a));}
  gallbladder.computeVertexNormals();duct.computeVertexNormals();
  duct.userData.attachments.push({host:"gallbladder",points});
}
