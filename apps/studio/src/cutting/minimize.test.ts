import {describe,it,expect} from "vitest";
import {minimizeIncremental} from "./minimize";

describe("frozen-history global incremental minimization",()=>{
 it("resolves strongly coupled contact-like modes with an exact energy line search",()=>{
  const x=new Float64Array([.3,.2,-.1,.1,.1,.2]),diagonal=new Float64Array(6).fill(10001);
  const evaluate=()=>{
   const q=x[0]!+x[3]!-.001,gradient=x.slice();gradient[0]!+=10000*q;gradient[3]!+=10000*q;
   return {energy:.5*x.reduce((sum,v)=>sum+v*v,0)+5000*q*q,gradient,minimumJacobian:1};
  };
  const before=evaluate().energy;expect(minimizeIncremental(x,evaluate,diagonal,-1,60)).toBeGreaterThan(0);
  expect(evaluate().energy).toBeLessThan(before*1e-5);expect(Math.max(...evaluate().gradient.map(Math.abs))).toBeLessThan(.004);
 });
 it("restores the last valid coordinates when every trial violates the Jacobian guard",()=>{
  const x=new Float64Array([1,0,0]),before=x.slice();
  const evaluate=()=>({energy:x[0]!**2/2,gradient:new Float64Array([x[0]!,0,0]),minimumJacobian:x[0]===1?1:.05});
  expect(minimizeIncremental(x,evaluate,new Float64Array([1,1,1]),-1)).toBe(0);expect(x).toEqual(before);
 });
});
