import { describe, expect, it, vi } from "vitest";
import { rankOnePreconditioner, type RankOneTerm } from "./preconditioner";

// Frozen allocating implementation, retained as an exact arithmetic reference.
// The independent dense-Cholesky checks live in review_preconditioner.test.ts.
function allocatingReference(base:Float64Array,terms:RankOneTerm[]) {
  const dot=(a:Float64Array,b:Float64Array)=>a.reduce((sum,v,i)=>sum+v*b[i]!,0);
  const diagonal=base.slice();for(const t of terms)t.indices.forEach((id,j)=>{diagonal[id]!+=t.stiffness*t.coefficients[j]!**2;});
  const multiply=(input:Float64Array)=>{
    const output=Float64Array.from(input,(v,i)=>v*base[i]!);
    for(const t of terms){let projection=0;for(let j=0;j<t.indices.length;j++)projection+=t.coefficients[j]!*input[t.indices[j]!]!;projection*=t.stiffness;for(let j=0;j<t.indices.length;j++)output[t.indices[j]!]!+=projection*t.coefficients[j]!;}
    return output;
  };
  const applyInverse=(input:Float64Array)=>{
    const output=new Float64Array(input.length),r=input.slice(),p=Float64Array.from(r,(v,i)=>v/diagonal[i]!);
    let rz=dot(r,p);const norm=dot(input,input);if(norm===0)return output;
    for(let iteration=0;iteration<96;iteration++){
      const hp=multiply(p),denominator=dot(p,hp);if(!(denominator>0)||!Number.isFinite(denominator))break;
      const alpha=rz/denominator;for(let i=0;i<output.length;i++){output[i]!+=alpha*p[i]!;r[i]!-=alpha*hp[i]!;}
      if(dot(r,r)<1e-8*norm)break;
      const z=Float64Array.from(r,(v,i)=>v/diagonal[i]!),next=dot(r,z),beta=next/rz;
      for(let i=0;i<p.length;i++)p[i]=z[i]!+beta*p[i]!;rz=next;
    }
    return output;
  };
  return { diagonal, multiply, applyInverse };
}

describe("scratch PCG preserves exact arithmetic and output ownership",()=>{
  it("matches the allocating reference for varied contact conditioning and histories of calls",()=>{
    for(const size of [6,24,96,945]) for(const stiffness of [0,5e3,8e6]) {
      const base=Float64Array.from({length:size},(_,i)=>3+i*.71),terms:RankOneTerm[]=[];
      for(let j=0;j<Math.min(size,48);j++)terms.push({
        indices:[j,(j+2)%size,(j+4)%size],coefficients:new Float64Array([.7,-.2,.3]),stiffness:stiffness*(1+j/20),
      });
      const original=allocatingReference(base,terms),cached=rankOnePreconditioner(base,terms);
      expect(cached.diagonal).toEqual(original.diagonal);
      const retained:{value:Float64Array;copy:Float64Array}[]=[];
      for(let seed=0;seed<6;seed++) {
        const input=Float64Array.from({length:size},(_,i)=>seed===0?0:Math.sin((seed+1)*(i+.3))+.2*Math.cos(i*1.7));
        const before=input.slice(),expected=original.applyInverse(input),actual=cached.applyInverse(input);
        expect(actual).toEqual(expected);expect(input).toEqual(before);
        expect(cached.multiply(input)).toEqual(original.multiply(input));
        retained.push({value:actual,copy:actual.slice()});
        for(const prior of retained)expect(prior.value).toEqual(prior.copy);
      }
      expect(new Set(retained.map(result=>result.value.buffer)).size).toBe(retained.length);
    }
  });

  it("does not expose scratch through public multiplication or zero solves",()=>{
    const p=rankOnePreconditioner(new Float64Array([2,3,4]),[{indices:[0,2],coefficients:new Float64Array([.3,.7]),stiffness:1e6}]);
    const input=new Float64Array([.1,-.2,.3]),product=p.multiply(input),copy=product.slice();
    const first=p.applyInverse(input),firstCopy=first.slice();
    p.applyInverse(new Float64Array(3));p.multiply(new Float64Array([1,2,3]));p.applyInverse(first);
    expect(product).toEqual(copy);expect(first).toEqual(firstCopy);
    expect(p.multiply(input).buffer).not.toBe(product.buffer);
    expect(()=>p.multiply(new Float64Array(2))).toThrow("vector size mismatch");
    expect(()=>p.applyInverse(new Float64Array(4))).toThrow("vector size mismatch");
  });

  it("allocates only the owned result during an inverse call",()=>{
    const size=24,base=Float64Array.from({length:size},(_,i)=>3+i*.71);
    const terms:RankOneTerm[]=[];
    for(let j=0;j<20;j++)terms.push({indices:[j,(j+2)%size,(j+4)%size],coefficients:new Float64Array([.7,-.2,.3]),stiffness:8e6});
    const cached=rankOnePreconditioner(base,terms),input=Float64Array.from({length:size},(_,i)=>Math.sin(i+.3));
    const Native=Float64Array;let allocations=0;
    class CountedArray extends Native { constructor(length:number) { super(length);allocations++; } }
    vi.stubGlobal("Float64Array",CountedArray);
    try {
      const result=cached.applyInverse(input);
      expect(allocations).toBe(1);expect(result.length).toBe(size);expect(result.every(Number.isFinite)).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });
});
