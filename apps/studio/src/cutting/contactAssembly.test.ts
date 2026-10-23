import fs from "node:fs";
import {describe,expect,it} from "vitest";
import {IntegratedContactAssembly} from "./contactAssembly";
import {DEFAULT_SCALPEL,type CuttingReference} from "./types";

describe("integrated source-cap contact assembly",()=>{
  it("maps unique energy, local forces and Gram consistently without retaining caller arrays",()=>{
    const mesh=JSON.parse(fs.readFileSync(new URL("../../public/cutting/liver-reference.json",import.meta.url),"utf8")) as CuttingReference;
    const positions=Float64Array.from(mesh.positionsMm,v=>v*.001);
    for(const pair of mesh.seamPairs){positions[3*pair.left]!-=.0001;positions[3*pair.right]!+=.0001;}
    const cap=mesh.cap!;let top=-Infinity,z=0;
    for(let i=0;i<cap.positionsMm.length;i+=3)if(cap.positionsMm[i+1]!>top){top=cap.positionsMm[i+1]!;z=cap.positionsMm[i+2]!;}
    const pose={active:true,tipYMm:top-1.5,centerZMm:z},assembly=new IntegratedContactAssembly(mesh,DEFAULT_SCALPEL),all=assembly.evaluateAll(positions,pose,true);
    expect(all.energyJ).toBeGreaterThan(0);expect(all.gramTerms.length).toBeGreaterThan(0);
    const order=Array.from({length:positions.length/3},(_,id)=>({id,magnitude:Math.hypot(...all.gradient.slice(3*id,3*id+3))})).sort((a,b)=>b.magnitude-a.magnitude);
    for(const {id} of order.slice(0,3)){
      const g=new Float64Array(3),h=new Float64Array(9);assembly.evaluateNode(id,positions,pose,g,h);
      for(let axis=0;axis<3;axis++){
        expect(g[axis]).toBe(all.gradient[3*id+axis]);
        const lo=positions.slice(),hi=positions.slice(),eps=1e-9;lo[3*id+axis]!-=eps;hi[3*id+axis]!+=eps;
        const fd=(assembly.evaluateAll(hi,pose).energyJ-assembly.evaluateAll(lo,pose).energyJ)/(2*eps);
        expect(Math.abs(fd-g[axis]!)).toBeLessThan(2e-5);
      }
      const block=new Float64Array(9);
      for(const term of all.gramTerms)for(let i=0;i<term.indices.length;i++)for(let j=0;j<term.indices.length;j++){
        const a=term.indices[i]!-3*id,b=term.indices[j]!-3*id;
        if(a>=0&&a<3&&b>=0&&b<3)block[3*a+b]!+=term.stiffness*term.coefficients[i]!*term.coefficients[j]!;
      }
      for(let i=0;i<9;i++)expect(Math.abs(block[i]!-h[i]!)).toBeLessThan(1e-8*Math.max(1,Math.abs(h[i]!)));
    }
    const saved=all.gradient.slice();assembly.evaluateAll(positions,{...pose,active:false});expect(all.gradient).toEqual(saved);
    const original=assembly.evaluateAll(positions,pose);
    mesh.planeXMm+=100;mesh.cap!.weights.fill(0);mesh.tets.fill(0);
    expect(assembly.evaluateAll(positions,pose).gradient).toEqual(original.gradient);
    const invalid=positions.slice();invalid[3*order[0]!.id]=NaN;
    expect(()=>assembly.evaluateAll(invalid,pose)).toThrow(/Finite|finite/);
  });
});
