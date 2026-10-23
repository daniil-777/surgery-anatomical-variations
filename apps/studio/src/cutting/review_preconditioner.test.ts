/** Independent dense reference and failure-path checks for the sparse inverse. */
import { describe,expect,it } from "vitest";
import { rankOnePreconditioner,type RankOneTerm } from "./preconditioner";
import { minimizeIncremental } from "./minimize";

const dot=(a:ArrayLike<number>,b:ArrayLike<number>)=>Array.from(a).reduce((sum,v,i)=>sum+v*b[i]!,0);
const norm=(a:ArrayLike<number>)=>Math.sqrt(dot(a,a));
function dense(base:Float64Array,terms:RankOneTerm[]) {
  const n=base.length,A=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?base[i]!:0));
  for(const term of terms)for(let i=0;i<term.indices.length;i++)for(let j=0;j<term.indices.length;j++)
    A[term.indices[i]!]![term.indices[j]!]!+=term.stiffness*term.coefficients[i]!*term.coefficients[j]!;
  return A;
}
function choleskySolve(A:number[][],b:Float64Array) {
  const n=b.length,L=Array.from({length:n},()=>new Float64Array(n)),y=new Float64Array(n),x=new Float64Array(n);
  for(let i=0;i<n;i++)for(let j=0;j<=i;j++) {
    let value=A[i]![j]!;for(let k=0;k<j;k++)value-=L[i]![k]!*L[j]![k]!;
    if(i===j){expect(value).toBeGreaterThan(0);L[i]![j]=Math.sqrt(value);}else L[i]![j]=value/L[j]![j]!;
  }
  for(let i=0;i<n;i++){let value=b[i]!;for(let j=0;j<i;j++)value-=L[i]![j]!*y[j]!;y[i]=value/L[i]![i]!;}
  for(let i=n-1;i>=0;i--){let value=y[i]!;for(let j=i+1;j<n;j++)value-=L[j]![i]!*x[j]!;x[i]=value/L[i]![i]!;}
  return x;
}

describe("independent coupled inverse review",()=>{
  it("matches dense SPD action and Cholesky solutions with bounded residual and unchanged inputs",()=>{
    const n=12,base=Float64Array.from({length:n},(_,i)=>3+i*.7);
    const terms:RankOneTerm[]=[
      {indices:[0,1,3,4,6,7],coefficients:new Float64Array([.42,-.11,.32,-.08,.26,-.07]),stiffness:8e6},
      {indices:[3,4,6,7,9,10],coefficients:new Float64Array([.19,-.04,.51,-.13,.3,-.08]),stiffness:3e6},
      ...[0,1,2,3,4,5].map(i=>({indices:[i,i+6],coefficients:new Float64Array([1,-1]),stiffness:4000+50*i})),
      {indices:[2,5,8,11],coefficients:new Float64Array([.1,.4,.3,.2]),stiffness:5e5},
    ];
    const originalBase=base.slice(),originalTerms=structuredClone(terms),A=dense(base,terms),p=rankOnePreconditioner(base,terms);
    const probes=Array.from({length:5},(_,seed)=>Float64Array.from({length:n},(_,i)=>Math.sin((seed+1)*(i+.3))+.2*Math.cos(i*1.7)));
    for(const b of probes) {
      const original=b.slice(),exactMultiply=Float64Array.from(A,row=>dot(row,b)),actualMultiply=p.multiply(b);
      expect(norm(actualMultiply.map((v,i)=>v-exactMultiply[i]!))/norm(exactMultiply)).toBeLessThan(1e-12);
      expect(dot(b,actualMultiply)).toBeGreaterThan(0);
      const x=p.applyInverse(b),exact=choleskySolve(A,b),residual=Float64Array.from(A,row=>dot(row,x)).map((v,i)=>v-b[i]!);
      expect(norm(residual)/norm(b)).toBeLessThan(1.1e-4);
      expect(norm(x.map((v,i)=>v-exact[i]!))/norm(exact)).toBeLessThan(5e-4);
      expect(dot(b,x)).toBeGreaterThan(0);expect(b).toEqual(original);
    }
    const a=probes[0]!,b=probes[1]!;
    expect(Math.abs(dot(a,p.multiply(b))-dot(b,p.multiply(a)))).toBeLessThan(1e-8);
    expect(p.applyInverse(new Float64Array(n))).toEqual(new Float64Array(n));
    expect(base).toEqual(originalBase);expect(terms).toEqual(originalTerms);
  });

  it("falls back to diagonal descent for non-descent or nonfinite inverse actions",()=>{
    for(const inverse of [(q:Float64Array)=>q.map(v=>-v),(q:Float64Array)=>q.map(()=>NaN)]) {
      const x=new Float64Array([.1,.2,-.3]),old=x.slice(),diagonal=new Float64Array([1,1,1]);
      const evaluate=()=>({energy:.5*dot(x,x),gradient:x.slice(),minimumJacobian:1});
      const initial=evaluate().energy;
      expect(minimizeIncremental(x,evaluate,diagonal,-1,3,inverse)).toBeGreaterThan(0);
      expect(evaluate().energy).toBeLessThan(initial);expect(norm(x)).toBeLessThan(1e-12);
      expect(old).toEqual(new Float64Array([.1,.2,-.3]));
    }
  });

  it("retains Armijo and inversion protection even for an oversized positive inverse action",()=>{
    const x=new Float64Array([.1,.2,-.3]),old=x.slice(),diagonal=new Float64Array([1,1,1]);
    const evaluate=()=>({energy:.5*dot(x,x),gradient:x.slice(),minimumJacobian:1});
    expect(minimizeIncremental(x,evaluate,diagonal,-1,3,q=>q.map(v=>1e6*v))).toBe(0);
    expect(x).toEqual(old);
    const p=rankOnePreconditioner(diagonal,[{indices:[0,1],coefficients:new Float64Array([1,.2]),stiffness:100}]);
    const guarded=()=>({...evaluate(),minimumJacobian:x.every((v,i)=>v===old[i])?1:.05});
    expect(minimizeIncremental(x,guarded,p.diagonal,-1,3,p.applyInverse)).toBe(0);expect(x).toEqual(old);
  });
});
