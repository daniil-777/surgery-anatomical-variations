import assert from 'node:assert/strict';
import { bladePlanes, integrateTrianglePenalty } from './contactIntegral';
import { DEFAULT_SCALPEL } from './types';
import {it} from "vitest";
it("integrates complete triangle contact, work-conjugate forces, medial ties and a PSD Gram",()=>{
const near = (a: number, b: number, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const pose = { active: true, tipYMm: 0, centerZMm: 0 }, area = 2e-6, stiffness = 8e11;
type Point = [number, number, number];
const checks: string[] = [];
const evaluate = (points: Point[], side: -1|1 = 1) => integrateTrianglePenalty(points, area, bladePlanes(0, pose, DEFAULT_SCALPEL, side), stiffness);
{
  const p: Point[] = [[.0005,.004,-.001],[.0005,.006,-.001],[.0005,.004,.001]];
  const r = evaluate(p), d = .0001;
  near(r.energyJ, .5 * stiffness * area * d * d, 1e-12);
  near(r.activeAreaM2, area, 1e-18);
  for (let i=0;i<3;i++) near(r.gradient[3*i]!, -stiffness*area*d/3, 1e-9);
  checks.push('constant penetration integrates analytic energy, area and force');
}
{
  const p: Point[] = [[0,.004,-.001],[0,.006,-.001],[0,.004,.001]];
  const left=evaluate(p,-1),right=evaluate(p,1);
  near(right.energyJ,.5*stiffness*area*.0006**2,1e-12);
  near(left.energyJ,right.energyJ,1e-12);
  near(right.activeAreaM2,area,1e-18);
  for(let i=0;i<9;i++)near(left.gradient[i]!,-right.gradient[i]!,1e-9);
  checks.push('positive-area medial tie counted once and selects declared material side');
}
{
  const p: Point[] = [[-.002,.004,-.001],[.002,.004,-.001],[0,.004,.002]];
  const r=evaluate(p);
  assert.ok(r.activeAreaM2>0&&r.activeAreaM2<area);
  assert.ok(r.energyJ>0);
  checks.push('finds triangle interior contact even when all vertices are outside');
}
{
  const cases: Point[][] = [
    [[.00005,.0004,-.001],[.0002,.001,.001],[.00035,.003,0]],
    [[-.001,.003,-.001],[.0012,.004,-.0005],[.00015,.004,.001]],
    [[.0001,.004,.009],[.0007,.006,.0097],[-.0003,.005,.0102]],
    [[.0001,.0158,-.001],[.0003,.0162,.001],[.0007,.0157,0]],
  ];
  let maxRelativeError=0;
  for(const p of cases){
    const r=evaluate(p),h=1e-9;
    for(let i=0;i<9;i++){
      const lo=p.map(v=>[...v] as Point),hi=p.map(v=>[...v] as Point);
      lo[Math.floor(i/3)]![i%3]!-=h;hi[Math.floor(i/3)]![i%3]!+=h;
      const fd=(evaluate(hi).energyJ-evaluate(lo).energyJ)/(2*h);
      const error=Math.abs(fd-r.gradient[i]!)/Math.max(1,Math.abs(fd));
      maxRelativeError=Math.max(maxRelativeError,error);assert.ok(error<2e-6,JSON.stringify({i,fd,analytic:r.gradient[i],error}));
    }
    const g=Float64Array.from({length:9},(_,i)=>Math.sin(i+1));
    const quadratic=g.reduce((sum,v,i)=>sum+v*g.reduce((a,w,j)=>a+r.gram[i*9+j]!*w,0),0);
    assert.ok(quadratic>=-1e-8);
  }
  checks.push(`piecewise energy gradient finite-difference maximum relative error ${maxRelativeError}; Gram positive semidefinite`);
}
{
  const p:Point[]=[[.0001,.004,.009],[.0007,.006,.0097],[-.0003,.005,.0102]],r=evaluate(p),h=1e-6;
  for(const [name,axis] of [['tipYMm',1],['centerZMm',2]] as const){
    const lo={...pose,[name]:-h},hi={...pose,[name]:h};
    const energy=(q:typeof pose)=>integrateTrianglePenalty(p,area,bladePlanes(0,q,DEFAULT_SCALPEL,1),stiffness).energyJ;
    const reaction=-(energy(hi)-energy(lo))/(2*h*.001);
    near(reaction,r.gradient[axis]!+r.gradient[3+axis]!+r.gradient[6+axis]!,1e-5);
  }
  checks.push('blade reaction is negative derivative of same pose-dependent energy');
}

});
