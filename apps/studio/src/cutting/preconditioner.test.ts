import {describe,it,expect} from "vitest";
import {rankOnePreconditioner} from "./preconditioner";
import {minimizeIncremental} from "./minimize";

describe("coupled contact Gram preconditioning",()=>{
 it("recovers a known solution for positive inertia plus stiff shared contact and pair blocks",()=>{
  const p=rankOnePreconditioner(new Float64Array([2,3,4,2,3,4]),[
   {indices:[0,1,3,4],coefficients:new Float64Array([.7,-.2,.3,-.1]),stiffness:8e6},
   {indices:[0,3],coefficients:new Float64Array([1,-1]),stiffness:4000},
   {indices:[2,5],coefficients:new Float64Array([1,-1]),stiffness:2000},
  ]);
  const known=new Float64Array([.003,-.002,.001,.004,.001,-.003]),b=p.multiply(known),answer=p.applyInverse(b),residual=p.multiply(answer);
  expect(Math.hypot(...residual.map((v,i)=>v-b[i]!))/Math.hypot(...b)).toBeLessThan(1e-4);
  expect(answer.reduce((sum,v,i)=>sum+v*b[i]!,0)).toBeGreaterThan(0);
  const energy=(x:Float64Array)=>x.reduce((sum,v,i)=>sum+v*p.multiply(x)[i]!,0);
  expect(energy(known)).toBeGreaterThan(0);
 });
 it("accelerates coupled energy descent without changing its minimizer",()=>{
  const p=rankOnePreconditioner(new Float64Array([1,1,1,1,1,1]),[{indices:[0,3],coefficients:new Float64Array([1,1]),stiffness:1e6}]);
  const x=new Float64Array([.2,.1,.1,.2,.1,.1]);
  const evaluate=()=>{const gradient=p.multiply(x);return {energy:x.reduce((sum,v,i)=>sum+.5*v*gradient[i]!,0),gradient,minimumJacobian:1};};
  expect(minimizeIncremental(x,evaluate,p.diagonal,-1,4,p.applyInverse)).toBeLessThanOrEqual(3);
  expect(Math.hypot(...evaluate().gradient)).toBeLessThan(.004);
 });
 it("rejects indefinite approximations",()=>{
  expect(()=>rankOnePreconditioner(new Float64Array([0]),[])).toThrow();
 });
});
