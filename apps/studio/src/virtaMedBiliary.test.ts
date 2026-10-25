import { expect, it } from "vitest";
import { createBiliaryEnvelope } from "./virtaMedBiliary";

it("forms one closed Y envelope with a shared label boundary and no internal branch caps",()=>{
 const parts=createBiliaryEnvelope(),vertices=new Map<string,number>(),edges=new Map<string,{count:number;orientation:number}>();
 for(const g of Object.values(parts)){
  const p=g.getAttribute("position"),index=g.index!,canonical:number[]=[];
  for(let i=0;i<p.count;i++){
   const key=[p.getX(i),p.getY(i),p.getZ(i)].join(",");if(!vertices.has(key))vertices.set(key,vertices.size);canonical.push(vertices.get(key)!);
  }
  for(let f=0;f<index.count;f+=3)for(let j=0;j<3;j++){
   const a=canonical[index.getX(f+j)]!,b=canonical[index.getX(f+(j+1)%3)]!,key=[Math.min(a,b),Math.max(a,b)].join(",");
   const edge=edges.get(key)??{count:0,orientation:0};edge.count++;edge.orientation+=a<b?1:-1;edges.set(key,edge);
  }
 }
 expect(parts["cystic-duct"]!.userData.junction.roots).toBeGreaterThan(10);
 for(const edge of edges.values()){expect(edge.count).toBe(2);expect(edge.orientation).toBe(0);}
 for(const g of Object.values(parts))g.dispose();
},15000);
