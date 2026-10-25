import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { SceneSurfaceContact } from "./wholeSceneContact";

type V3 = [number,number,number];
const smooth=(x:number)=>{const t=Math.max(0,Math.min(1,x));return t*t*(3-2*t);};
const hash=(x:number,y:number,z:number)=>{const n=Math.sin(x*127.1+y*311.7+z*74.7)*43758.5453123;return n-Math.floor(n);};
/** Loft UV seams and collapsed poles share one geometric normal. Averaging
 * before displacement prevents the detail pass opening a slit at those seams. */
function continuousNormals(geometry:THREE.BufferGeometry) {
  geometry.computeVertexNormals();const p=geometry.getAttribute("position"),n=geometry.getAttribute("normal"),groups=new Map<string,{ids:number[];normal:THREE.Vector3}>();
  for(let i=0;i<p.count;i++){const key=[p.getX(i),p.getY(i),p.getZ(i)].map(x=>Math.round(x*1e4)).join(",");let group=groups.get(key);if(!group){group={ids:[],normal:new THREE.Vector3()};groups.set(key,group);}group.ids.push(i);group.normal.add(new THREE.Vector3().fromBufferAttribute(n,i));}
  for(const {ids,normal} of groups.values()){normal.normalize();for(const i of ids)n.setXYZ(i,normal.x,normal.y,normal.z);}
}
export function anatomicalNoise(x:number,y:number,z:number) {
  const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z),fx=smooth(x-ix),fy=smooth(y-iy),fz=smooth(z-iz);
  let sum=0;for(let c=0;c<8;c++){const dx=c&1,dy=(c>>1)&1,dz=(c>>2)&1;sum+=hash(ix+dx,iy+dy,iz+dz)*(dx?fx:1-fx)*(dy?fy:1-fy)*(dz?fz:1-fz);}return sum*2-1;
}
export function detailCapsule(geometry:THREE.BufferGeometry,kind:"liver"|"bowel"|"gallbladder") {
  continuousNormals(geometry);const p=geometry.getAttribute("position"),n=geometry.getAttribute("normal");
  for(let i=0;i<p.count;i++){
    let x=p.getX(i),y=p.getY(i),z=p.getZ(i);
    const relief=(kind==="liver"?.38:kind==="bowel"?.28:.2)*anatomicalNoise(x/9,y/9,z/9)+.08*anatomicalNoise(x/3.6,y/3.6,z/3.6);
    x+=n.getX(i)*relief;y+=n.getY(i)*relief;z+=n.getZ(i)*relief;
    if(kind==="liver"){
      const inferior=1-smooth((y-28)/30),anterior=smooth((z+45)/50);
      y+=inferior*(5*Math.exp(-1*((x-6)/11)**2)-6*Math.exp(-1*((x+30)/28)**2)-3*Math.exp(-1*((x-64)/24)**2));
      z-=anterior*(5*Math.exp(-1*((x-7)/6)**2)*Math.exp(-1*((y-37)/24)**2)+2.2*Math.exp(-1*((x+103)/13)**2)*Math.exp(-1*((y-30)/15)**2));
    }
    p.setXYZ(i,x,y,z);
  }
  continuousNormals(geometry);
}

export function surfaceFor(id:string,geometry:THREE.BufferGeometry) {
  return new SceneSurfaceContact(id,geometry.getAttribute("position").array as Float32Array,geometry.index!.array as Uint16Array|Uint32Array);
}
/** Insert an attachment into its host surface. Feature classification uses a
 * physical distance tolerance bounded by Float32 storage precision, not a fixed
 * barycentric threshold: a narrow host triangle can otherwise produce a child
 * whose altitude is smaller than one coordinate ULP. Such a sliver can reverse
 * its discrete normal under harmless smooth deformation after quantization.
 * Edge snaps split every incident face, including duplicated UV-seam edges. */
export function registerSurfacePoint(geometry:THREE.BufferGeometry,point:number[]):V3 {
  const hit=surfaceFor("host",geometry).closestPoint(point);if(!hit)throw new Error("Attachment has no host surface.");
  const p=geometry.getAttribute("position"),uv=geometry.getAttribute("uv"),ids=hit.vertexIndices;
  const vertices=ids.map(id=>new THREE.Vector3().fromBufferAttribute(p,id)),location=new THREE.Vector3(...hit.pointMm);
  const maximumEdge=Math.max(...vertices.map((v,i)=>v.distanceTo(vertices[(i+1)%3]!)));
  const ulp=(value:number)=>Math.max(2**-149,2**(Math.floor(Math.log2(Math.abs(value)||Number.MIN_VALUE))-23));
  const storageUlp=Math.max(...vertices.flatMap(v=>v.toArray()).map(ulp));
  const tolerance=Math.max(16*storageUlp,maximumEdge*1e-6);
  const record=(result:V3,feature:"vertex"|"edge"|"interior")=>{
    const stats=geometry.userData.attachmentRegistration??{method:"Float32-aware geometric feature snapping",vertexSnaps:0,edgeSnaps:0,interiorInsertions:0,maxDisplacementMm:0,maxToleranceMm:0};
    stats[feature==="vertex"?"vertexSnaps":feature==="edge"?"edgeSnaps":"interiorInsertions"]++;
    stats.maxDisplacementMm=Math.max(stats.maxDisplacementMm,Math.hypot(...result.map((v,i)=>v-hit.pointMm[i]!)));
    stats.maxToleranceMm=Math.max(stats.maxToleranceMm,tolerance);geometry.userData.attachmentRegistration=stats;return result;
  };
  for(let i=0;i<3;i++)if(location.distanceTo(vertices[i]!)<=tolerance)return record(vertices[i]!.toArray() as V3,"vertex");
  let edge=-1,nearest=Infinity,edgeT=0;
  for(let i=0;i<3;i++){
    const a=vertices[i]!,b=vertices[(i+1)%3]!,direction=b.clone().sub(a),lengthSq=direction.lengthSq();
    if(!lengthSq)continue;
    const t=THREE.MathUtils.clamp(location.clone().sub(a).dot(direction)/lengthSq,0,1),projected=a.clone().addScaledVector(direction,t),distance=location.distanceTo(projected);
    if(distance<=tolerance&&distance<nearest){edge=i;nearest=distance;edgeT=t;}
  }
  if(edge>=0){location.copy(vertices[edge]!).lerp(vertices[(edge+1)%3]!,edgeT);
    for(let i=0;i<3;i++)if(location.distanceTo(vertices[i]!)<=tolerance)return record(vertices[i]!.toArray() as V3,"vertex");
  }
  const result:V3=location.toArray().map(Math.fround) as V3,positions=Array.from(p.array),tex=Array.from(uv.array),out:number[]=[],index=geometry.index!;
  const addedByUv=new Map<string,number>();
  const insert=(u:number,v:number)=>{const key=[Math.fround(u),Math.fround(v)].join(",");let added=addedByUv.get(key);if(added===undefined){added=positions.length/3;positions.push(...result);tex.push(u,v);addedByUv.set(key,added);}return added;};
  const samePosition=(a:number,b:number)=>p.getX(a)===p.getX(b)&&p.getY(a)===p.getY(b)&&p.getZ(a)===p.getZ(b);
  const added=edge<0?insert(ids.reduce((sum,id,i)=>sum+uv.getX(id)*hit.barycentric[i]!,0),ids.reduce((sum,id,i)=>sum+uv.getY(id)*hit.barycentric[i]!,0)):-1;
  for(let f=0;f<index.count;f+=3){const triangle=[index.getX(f),index.getX(f+1),index.getX(f+2)];
    if(edge>=0){const e0=ids[edge]!,e1=ids[(edge+1)%3]!;let split=false;
      for(let k=0;k<3;k++){const a=triangle[k]!,b=triangle[(k+1)%3]!,c=triangle[(k+2)%3]!,forward=samePosition(a,e0)&&samePosition(b,e1),reverse=samePosition(a,e1)&&samePosition(b,e0);
        if(forward||reverse){const t=forward?edgeT:1-edgeT,added=insert(THREE.MathUtils.lerp(uv.getX(a),uv.getX(b),t),THREE.MathUtils.lerp(uv.getY(a),uv.getY(b),t));out.push(a,added,c,added,b,c);split=true;break;}
      }if(!split)out.push(...triangle);
    }else if(f/3===hit.triangleIndex){const [a,b,c]=triangle as V3;out.push(a,b,added,b,c,added,c,a,added);}else out.push(...triangle);
  }
  geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute("uv",new THREE.Float32BufferAttribute(tex,2));
  geometry.setIndex(out);return record(result,edge>=0?"edge":"interior");
}

/** A sheet with a varying thickness and a closed edge; no inflated tube caps. */
export function foldedSheet(nu:number,nv:number,point:(u:number,v:number,back:boolean)=>V3) {
  const p:number[]=[],uv:number[]=[],index:number[]=[],layer=(nu+1)*(nv+1);
  for(let back=0;back<2;back++)for(let i=0;i<=nu;i++)for(let j=0;j<=nv;j++){
    p.push(...point(i/nu,j/nv,Boolean(back)));uv.push(i/nu,j/nv);
    if(i<nu&&j<nv){const a=back*layer+i*(nv+1)+j,b=a+nv+1;
      if(back)index.push(a,a+1,b,a+1,b+1,b);else index.push(a,b,a+1,a+1,b,b+1);
    }
  }
  for(let i=0;i<nu;i++)for(const j of [0,nv]){const a=i*(nv+1)+j,b=a+nv+1;if(j===0)index.push(a,a+layer,b,b,a+layer,b+layer);else index.push(a,b,a+layer,b,b+layer,a+layer);}
  for(let j=0;j<nv;j++)for(const i of [0,nu]){const a=i*(nv+1)+j,b=a+1;if(i===0)index.push(a,b,a+layer,b,b+layer,a+layer);else index.push(a,a+layer,b,b,a+layer,b+layer);}
  const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(p,3));g.setAttribute("uv",new THREE.Float32BufferAttribute(uv,2));g.setIndex(index);g.computeVertexNormals();return g;
}

export function drapedFat(supports:THREE.BufferGeometry[]) {
  const surfaces=supports.map((g,i)=>surfaceFor(`support-${i}`,g));
  const nu=190,nv=26,top:V3[]=[],bottom:V3[]=[],obstacle:number[]=[],xy:[number,number][]=[];
  for(let i=0;i<=nu;i++)for(let j=0;j<=nv;j++){
    const t=i/nu,v=j/nv,u=v*2-1,x=-176+352*t;
    const width=10+7*t+2*Math.sin(t*13),y=-82+32*t+4*Math.sin(t*8)+u*width+1.7*Math.sin(x*.15+v*3);
    let support=-Infinity;for(const s of surfaces){const hit=s.raycast([x,y,130],[0,0,-1]);if(hit)support=Math.max(support,hit.pointMm[2]);}
    obstacle.push(support);xy.push([x,y]);
  }
  // A tensioned apron bridges the gaps between supports. Directly sampling a
  // ray height produces vertical curtains wherever a ray misses the bowel.
  const height=obstacle.map((z,k)=>{
    const row=Math.floor(k/(nv+1));return Math.max(20,z,...obstacle.slice(row*(nv+1),(row+1)*(nv+1)));
  });
  for(let pass=0;pass<100;pass++)for(let i=0;i<=nu;i++)for(let j=0;j<=nv;j++){
    const k=i*(nv+1)+j,neighbors=[height[Math.max(0,i-1)*(nv+1)+j]!,height[Math.min(nu,i+1)*(nv+1)+j]!,height[i*(nv+1)+Math.max(0,j-1)]!,height[i*(nv+1)+Math.min(nv,j+1)]!];
    height[k]=Math.max(obstacle[k]!+.22,neighbors.reduce((a,b)=>a+b,0)/4);
  }
  for(let i=0;i<=nu;i++)for(let j=0;j<=nv;j++){
    const k=i*(nv+1)+j,t=i/nu,v=j/nv,u=v*2-1,[x,y]=xy[k]!;
    const edge=Math.sin(Math.PI*v),wrinkle=(.7+1.1*t)*Math.sin(x*.28+u*2+Math.sin(x*.09))*edge;
    const grain=anatomicalNoise(x/5,y/5,3)*.6*edge;
    const thickness=(.12+3.08*edge)*( .85+.15*Math.sin(x*.21));
    const z=height[k]!+Math.max(0,wrinkle+grain);
    top.push([x,y,z+thickness]);bottom.push([x,y,z]);
  }
  return foldedSheet(nu,nv,(u,v,back)=>(back?bottom:top)[Math.round(u*nu)*(nv+1)+Math.round(v*nv)]!);
}

/** Sheet boundaries are exact host vertices. All parts use the same deformation
 * map, so these registered attachments remain coincident under shape/physics. */
export function hepaticAttachment(liver:THREE.BufferGeometry,gb:THREE.BufferGeometry) {
  const liverSurface=surfaceFor("liver",liver),gp=gb.getAttribute("position");
  const rows=48,sides=64,a:V3[]=[],b:V3[]=[],an:THREE.Vector3[]=[],bn:THREE.Vector3[]=[],gn=gb.getAttribute("normal");
  for(let row=0;row<=rows;row++){
    const ring=Math.round(12+row/rows*68);let chosen=ring*(sides+1),best=-Infinity;
    for(let j=0;j<=sides;j++){const id=ring*(sides+1)+j,score=.6*gp.getY(id)-gp.getZ(id);if(score>best){best=score;chosen=id;}}
    const p:V3=[gp.getX(chosen),gp.getY(chosen),gp.getZ(chosen)];
    const hit=liverSurface.closestPoint(p);
    if(!hit)throw new Error("Hepatic attachment missed the capsule.");
    a.push(p);b.push(registerSurfacePoint(liver,hit.pointMm));an.push(new THREE.Vector3().fromBufferAttribute(gn,chosen).normalize());bn.push(new THREE.Vector3(...hit.normal).normalize());
  }
  const geometry=foldedSheet(rows,24,(u,v,back)=>{
    const i=Math.round(u*rows),from=new THREE.Vector3(...a[i]!),to=new THREE.Vector3(...b[i]!);
    if(v===0)return a[i]!;if(v===1)return b[i]!;
    const direction=to.clone().sub(from),ta=direction.clone().addScaledVector(an[i]!,-direction.dot(an[i]!)),tb=direction.clone().addScaledVector(bn[i]!,-direction.dot(bn[i]!));
    const v2=v*v,v3=v2*v,h00=2*v3-3*v2+1,h10=v3-2*v2+v,h01=-2*v3+3*v2,h11=v3-v2;
    const point=from.multiplyScalar(h00).addScaledVector(ta,h10).addScaledVector(to,h01).addScaledVector(tb,h11);
    const taper=Math.sin(Math.PI*v)**2,fold=taper*Math.sin(u*31+v*4)*.55;
    point.addScaledVector(an[i]!.clone().lerp(bn[i]!,v).normalize(),taper*.35);point.y+=fold*.25;point.z+=fold-(back?.16*taper:0);
    return point.toArray() as V3;
  });
  geometry.userData.attachments=[{host:"gallbladder",points:a},{host:"liver",points:b}];
  return geometry;
}

export function cranialAttachment(liver:THREE.BufferGeometry) {
  const surface=surfaceFor("liver",liver),nv=80,roots:V3[]=[];
  for(let i=0;i<=24;i++){const u=i/24*2-1,x=9+16*u,y=44+14*u*u,hit=surface.raycast([x,y,130],[0,0,-1]);if(!hit)throw new Error("Cranial sheet root missed the liver capsule.");roots.push(registerSurfacePoint(liver,hit.pointMm));}
  const nu=roots.length-1;
  const geometry=foldedSheet(nu,nv,(u,v,back)=>{
    const root=roots[Math.round(u*nu)]!,side=u*2-1,widen=side*25*v;
    if(v===0)return root;
    const x=root[0]+49*v+widen,y=root[1]+126*v,fold=Math.sin(side*5+v*9)*1.4*Math.sin(Math.PI*v),support=surface.raycast([x,y,130],[0,0,-1]);
    const z=Math.max(root[2]+24*Math.sin(v*Math.PI)-26*v*v+fold,(support?.pointMm[2]??-Infinity)+.22);
    return [x,y,z+(back?0:.35*Math.sin(Math.PI*v))];
  });geometry.userData.attachments=[{host:"liver",points:roots}];return geometry;
}

export function joinSurfaces(...parts:THREE.BufferGeometry[]) {
  const merged=mergeGeometries(parts);if(!merged)throw new Error("Connected tissue surfaces could not be assembled.");parts.forEach(p=>p.dispose());return merged;
}

/** A thin continuous bridge joins the hepatocystic pad to the draped apron.
 * Register both boundaries rather than relying on overlapping silhouettes. */
export function joinedFat(pad:THREE.BufferGeometry,apron:THREE.BufferGeometry) {
  const from:V3[]=[],to:V3[]=[],nu=20,ps=surfaceFor("pad",pad),as=surfaceFor("apron",apron);
  for(let i=0;i<=nu;i++){
    const u=i/nu,x=-104+20*u,y=-65-4*Math.sin(u*Math.PI),a=ps.raycast([x,y,130],[0,0,-1])??ps.closestPoint([x,y,40]);
    const b=as.closestPoint([-111+28*u,-81+2*Math.sin(u*4),55]);
    if(!a||!b)throw new Error("Fat bridge has no supporting surface.");
    from.push(registerSurfacePoint(pad,a.pointMm));to.push(registerSurfacePoint(apron,b.pointMm));
  }
  const bridge=foldedSheet(nu,18,(u,v,back)=>{
    const a=from[Math.round(u*nu)]!,b=to[Math.round(u*nu)]!,fold=Math.sin(Math.PI*v)*(.4*Math.sin(u*13)-.7);
    return [a[0]+(b[0]-a[0])*v,a[1]+(b[1]-a[1])*v,a[2]+(b[2]-a[2])*v+fold+(back?-.3*Math.sin(Math.PI*v):0)];
  });
  pad.computeVertexNormals();apron.computeVertexNormals();
  const coverRange={start:pad.getAttribute("position").count,count:191*27*2,rows:190,columns:26};
  const geometry=joinSurfaces(pad,apron,bridge);geometry.userData.internalAttachments=[...from,...to];geometry.userData.coverRange=coverRange;return geometry;
}

/** Match the complete neck ring, including its orientation, then blend the
 * next rings into the duct. The same spatial physics map moves both copies. */
export function attachDuct(gallbladder:THREE.BufferGeometry,duct:THREE.BufferGeometry,sides=64) {
  const host=gallbladder.getAttribute("position"),p=duct.getAttribute("position"),start=host.count-sides-1;
  const points:V3[]=[];
  let shift=0,best=Infinity;
  for(let s=0;s<sides;s++){let distance=0;for(let j=0;j<sides;j++){const k=start+(j+s)%sides;distance+=(host.getX(k)-p.getX(j))**2+(host.getY(k)-p.getY(j))**2+(host.getZ(k)-p.getZ(j))**2;}if(distance<best){best=distance;shift=s;}}
  for(let j=0;j<=sides;j++){
    const k=start+(j+shift)%sides,target:V3=[host.getX(k),host.getY(k),host.getZ(k)];points.push(target);
    const offset=[target[0]-p.getX(j),target[1]-p.getY(j),target[2]-p.getZ(j)];
    for(let ring=0;ring<7;ring++){const i=ring*(sides+1)+j,w=1-smooth(ring/7);p.setXYZ(i,p.getX(i)+offset[0]!*w,p.getY(i)+offset[1]!*w,p.getZ(i)+offset[2]!*w);}
  }
  duct.computeVertexNormals();duct.userData.attachments=[{host:"gallbladder",points}];
}
