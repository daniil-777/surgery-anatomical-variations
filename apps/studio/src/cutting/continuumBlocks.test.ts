import assert from 'node:assert/strict';
import { describe, it, expect } from 'vitest';
import {continuumBlocks} from './continuumBlocks';
const p={young_pa:4800,poisson:.45,relaxation_fraction:.42,relaxation_time_s:.65,density_kg_m3:1060,contact_stiffness_n_m:300,indentation_stiffness_n_m:20000,fracture_energy_j_m2:20},dt=1/480;
const K=p.young_pa/(3*(1-2*p.poisson)),mu0=p.young_pa/(2*(1+p.poisson)),mu=3*K*p.young_pa*(1-p.relaxation_fraction)/(9*K-p.young_pa*(1-p.relaxation_fraction)),branch=mu0-mu,tau=p.relaxation_time_s*(3*K+mu)/(3*K+mu0),ramp=-Math.expm1(-dt/tau)*tau/dt,decay=Math.exp(-dt/tau),lambda=K-2*mu/3;
const V=1e-6/6,cell={ids:[0,1,2,3],volume:V,gradients:new Float64Array([-100,-100,-100,100,0,0,0,100,0,0,0,100])};
const det=(F:number[])=>F[0]!*(F[4]!*F[8]!-F[5]!*F[7]!)-F[1]!*(F[3]!*F[8]!-F[5]!*F[6]!)+F[2]!*(F[3]!*F[7]!-F[4]!*F[6]!);
const ftf=(F:number[])=>Array.from({length:9},(_,i)=>{const r=Math.floor(i/3),c=i%3;return F[r]!*F[c]!+F[3+r]!*F[3+c]!+F[6+r]!*F[6+c]!;});
const dev=(A:number[])=>{const a=A.slice(),trace=(a[0]!+a[4]!+a[8]!)/3;for(const i of [0,4,8])a[i]!-=trace;return a;};
const dot=(a:ArrayLike<number>,b:ArrayLike<number>)=>{let sum=0;for(let i=0;i<a.length;i++)sum+=a[i]!*b[i]!;return sum;};
const strain=(F:number[])=>dev(ftf(F).map(x=>x/2));
const previous=[.01,.005,-.003,.005,-.02,.004,-.003,.004,.01],memory=[.02,.001,.004,.001,-.013,-.002,.004,-.002,-.007];
const energy=(F:number[],history=true)=>{const J=det(F),l=Math.log(J),e=strain(F),c=e.map((v,i)=>v-(history?previous[i]!:0)+(history?decay/ramp*memory[i]!:0));return V*(mu/2*(dot(F,F)-3)-mu*l+.5*lambda*l*l+branch*ramp*dot(c,c));};
const positions=(F:number[])=>new Float64Array([0,0,0,F[0]!*.01,F[3]!*.01,F[6]!*.01,F[1]!*.01,F[4]!*.01,F[7]!*.01,F[2]!*.01,F[5]!*.01,F[8]!*.01]);
describe('continuum optimizer Gram',()=>{
 it('matches independent finite-strain Hessian decomposition, including loaded memory and omitted rotational curvature',()=>{
let maxDecompositionError=0,minGram=Infinity;const cases=[];
for(const F of [[1,0,0,0,1,0,0,0,1],[.42,.17,0,.05,1.12,.03,.01,-.04,.97],[1.6,.1,0,0,1.5,.03,.02,0,1.4]]){
 const block=continuumBlocks(positions(F),[cell],p,dt,'log-neo-hookean')[0]!.values,J=det(F),l=Math.log(J),first=(-mu+lambda*l)/J,second=(mu+lambda*(1-l))/J**2;
 for(let trial=0;trial<12;trial++){
  const D=Array.from({length:9},(_,i)=>.2*Math.sin(.77*i+.39*trial)),direction=positions(D),eps=2e-4,plus=F.map((v,i)=>v+eps*D[i]!),minus=F.map((v,i)=>v-eps*D[i]!);
  const dJ=(det(plus)-det(minus))/(2*eps),ddJ=(det(plus)-2*J+det(minus))/eps**2;
  const e=strain(F),de=strain(plus).map((v,i)=>(v-strain(minus)[i]!)/(2*eps)),dde=dev(ftf(D)),c=e.map((v,i)=>v-previous[i]!+decay/ramp*memory[i]!);
  let gram=0;for(let i=0;i<12;i++)for(let j=0;j<12;j++)gram+=direction[i]!*block[12*i+j]!*direction[j]!;
  const independentGram=V*(mu*dot(D,D)+Math.max(0,second)*dJ*dJ+2*branch*ramp*dot(de,de));
  assert.ok(Math.abs(gram-independentGram)<2e-11);minGram=Math.min(minGram,gram);
  const omitted=V*(first*ddJ+Math.min(0,second)*dJ*dJ+2*branch*ramp*dot(c,dde));
  const full=(energy(plus)-2*energy(F)+energy(minus))/eps**2,error=Math.abs(full-gram-omitted);maxDecompositionError=Math.max(maxDecompositionError,error);assert.ok(error<1e-9);
 }
 cases.push({J,volumetricCurvaturePa:second});
}
// Gram is not the exact stress-free Hessian: rotational cancellation requires
// the intentionally omitted φ' d²J term. Exact energy/forces must remain used.
const I=[1,0,0,0,1,0,0,0,1],Omega=[0,-1,0,1,0,0,0,0,0],dir=positions(Omega),rest=continuumBlocks(positions(I),[cell],p,dt,'log-neo-hookean')[0]!.values;
let rotationGram=0;for(let i=0;i<12;i++)for(let j=0;j<12;j++)rotationGram+=dir[i]!*rest[12*i+j]!*dir[j]!;
const h=1e-4,plus=I.map((v,i)=>v+h*Omega[i]!),minus=I.map((v,i)=>v-h*Omega[i]!),fullRotation=(energy(plus,false)+energy(minus,false)-2*energy(I,false))/h**2;
assert.ok(rotationGram>0);assert.ok(Math.abs(fullRotation)<1e-10);assert.ok(Math.abs(rotationGram-2*mu*V)<1e-14);

 });

 it('is symmetric and translation invariant, retains ownership, and rejects invalid states',()=>{
  const x=positions([.7,.04,0,0,.9,.02,0,0,.8]),savedX=x.slice(),savedG=cell.gradients.slice();
  const first=continuumBlocks(x,[cell],p,dt,'log-neo-hookean')[0]!;
  let scale=0;for(const v of first.values)scale=Math.max(scale,Math.abs(v));
  for(let i=0;i<12;i++){
   for(let j=0;j<12;j++)expect(Math.abs(first.values[12*i+j]!-first.values[12*j+i]!)).toBeLessThan(1e-12*scale);
   for(let axis=0;axis<3;axis++){let sum=0;for(let j=0;j<4;j++)sum+=first.values[12*i+3*j+axis]!;expect(Math.abs(sum)).toBeLessThan(1e-12*scale);}
  }
  const retained=first.values.slice();continuumBlocks(x,[cell],p,dt,'stable-neo-hookean');expect(first.values).toEqual(retained);expect(x).toEqual(savedX);expect(cell.gradients).toEqual(savedG);
  first.ids[0]=99;expect(cell.ids[0]).toBe(0);
  expect(()=>continuumBlocks(x,[cell],p,0,'log-neo-hookean')).toThrow();
  expect(()=>continuumBlocks(x,[{...cell,volume:0}],p,dt,'log-neo-hookean')).toThrow();
  expect(()=>continuumBlocks(x,[{...cell,ids:[0,1,1,3]}],p,dt,'log-neo-hookean')).toThrow();
  const invalid=x.slice();invalid[3]=NaN;expect(()=>continuumBlocks(invalid,[cell],p,dt,'log-neo-hookean')).toThrow();
  expect(()=>continuumBlocks(positions([-1,0,0,0,1,0,0,0,1]),[cell],p,dt,'log-neo-hookean')).toThrow();
 });

});
