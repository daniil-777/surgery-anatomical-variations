import {expect,it} from "vitest";
import {bladePlanes,integrateTrianglePenalty,type TriangleGramTerm} from "./contactIntegral";
import {TrianglePenaltyScratch} from "./contactIntegralScratch";
import {DEFAULT_SCALPEL} from "./types";
it("rejects malformed finite unit plane tuples",()=>{
  const malformed=[{normal:[1,0] as unknown as [number,number,number],offset:0}];
  expect(()=>new TrianglePenaltyScratch(malformed,1)).toThrow(/halfspaces/);
  expect(()=>integrateTrianglePenalty([[0,1,0],[0,2,0],[0,1,1]],1,malformed,1)).toThrow(/halfspaces/);
});
it("preserves the exact integral across mixed features, ties and output reuse",()=>{
  for(const side of [-1,1] as const){
    const planes=bladePlanes(0,{tipYMm:0,centerZMm:0,active:true},DEFAULT_SCALPEL,side),kernel=new TrianglePenaltyScratch(planes,8e11);
    for(let i=0;i<90;i++){
      const points=Array.from({length:3},(_,j)=>[i%9===0?0:.001*Math.sin(i*7+j*3),.008+.01*Math.cos(i+j*5),.01*Math.sin(i*3+j)] as [number,number,number]);
      const expected=integrateTrianglePenalty(points,2e-6,planes,8e11,{terms:true}),g=new Float64Array(9),h=new Float64Array(81),terms:TriangleGramTerm[]=[];
      const actual=kernel.evaluate(points,2e-6,g,h,terms);
      expect(actual.energyJ).toBe(expected.energyJ);expect(actual.activeAreaM2).toBe(expected.activeAreaM2);expect(g).toEqual(expected.gradient);expect(h).toEqual(expected.gram);expect(terms).toEqual(expected.terms);
      const retained=g.slice();kernel.evaluate([[3,4,5],[2,1,3],[1,2,3]],1e-6,new Float64Array(9),new Float64Array(0));expect(g).toEqual(retained);
    }
  }
});
