import { describe,expect,it } from "vitest";
import { solveStrainStiffening } from "./sceneTissueResponse";
import { WholeScenePhysics,type LearnedSceneMaterials,type ScenePhysicsOrgan } from "./wholeScenePhysics";

describe("implicit strain-stiffening response",()=>{
  it("solves the nonlinear force balance for oblique push, grasp and released states",()=>{
    for(const mode of ["push","grasp","none"] as const)for(const cubic of [0,2e6,5e8])for(const sign of [-1,1]){
      const rhs=[.23,-.18,.08],n=[.6,0,.8],desired=[sign*.012,.006,-.009],q=new Float64Array([.01,-.01,.01]);
      const d=800,k=180,g=.83;
      solveStrainStiffening(q,rhs,d,cubic,mode,k,g,desired,n);
      const r2=q.reduce((s,x)=>s+x*x,0),penetration=g*q.reduce((s,x,i)=>s+x*n[i]!,0)-desired.reduce((s,x,i)=>s+x*n[i]!,0);
      for(let a=0;a<3;a++){
        const contact=mode==="grasp"?k*g*(g*q[a]!-desired[a]!):mode==="push"?k*g*Math.max(0,penetration)*n[a]!:0;
        expect((d+cubic*r2)*q[a]!+contact-rhs[a]!).toBeCloseTo(0,9);
      }
    }
  });
  it("retains rotational symmetry for a grasp and increases resistance with strain",()=>{
    const linear=new Float64Array(3),nonlinear=new Float64Array(3),rotated=new Float64Array(3);
    solveStrainStiffening(linear,[0,0,0],80,0,"grasp",180,1,[.012,0,0],[0,0,1]);
    solveStrainStiffening(nonlinear,[0,0,0],80,2e6,"grasp",180,1,[.012,0,0],[0,0,1]);
    solveStrainStiffening(rotated,[0,0,0],80,2e6,"grasp",180,1,[0,0,.012],[1,0,0]);
    expect(nonlinear[0]).toBeLessThan(linear[0]!* .9);expect(rotated[2]).toBeCloseTo(nonlinear[0]!,12);
  });
});

const organs:ScenePhysicsOrgan[]=[{id:"liver",category:"digestive",bounds:{min:[-80,-50,-30],max:[80,50,50]}}];
const materials:LearnedSceneMaterials={schema_version:"whole-scene-materials-1.0.0",model_id:"a".repeat(64),scope:"synthetic test",materials:[{id:"liver",young_pa:4200,relaxation_fraction:.4,relaxation_time_s:.7,density_kg_m3:1050,accepted_for_application:true,observation_origin:"synthetic-design-history"}]};
const profile={liver:{strainStiffening:40,localDampingRatio:.9,supportRadiusRatio:2}};
const advance=(s:WholeScenePhysics,seconds:number,dt=1/60)=>{for(let i=0;i<Math.round(seconds/dt);i++)s.step(dt,false);};
function attach(s:WholeScenePhysics,depth:number){s.beginToolContact({mode:"grasp",organId:"liver",restPointMm:[0,0,40],normal:[0,0,1],targetPointMm:[depth,0,40],radiusMm:6});}
describe("tissue-specific scene response",()=>{
  it("lets settled surfaces sleep without freezing physical time and wakes on force",()=>{
    const solver=new WholeScenePhysics(organs,materials,profile);advance(solver,1);expect(solver.motionActive).toBe(false);
    attach(solver,3);expect(solver.motionActive).toBe(true);advance(solver,.8);solver.releaseToolContact();advance(solver,18);
    expect(solver.motionActive).toBe(false);expect(solver.snapshot().time_s).toBeCloseTo(19.8,8);
    solver.pulse("liver");expect(solver.motionActive).toBe(true);advance(solver,.1);expect(solver.snapshot().displacement_mm).toBeGreaterThan(.001);
  });
  it("preserves small-strain behavior but stiffens under a larger held displacement",()=>{
    for(const depth of [.2,8]){
      const linear=new WholeScenePhysics(organs,materials),nonlinear=new WholeScenePhysics(organs,materials,profile);
      attach(linear,depth);attach(nonlinear,depth);advance(linear,3);advance(nonlinear,3);
      const a=linear.toolSnapshot()!,b=nonlinear.toolSnapshot()!;
      if(depth<1)expect(b.displacementMm[0]!/a.displacementMm[0]!).toBeCloseTo(1,3);
      else {expect(b.forceN[0]).toBeGreaterThan(a.forceN[0]!*1.1);expect(b.displacementMm[0]).toBeLessThan(a.displacementMm[0]!);}
      expect(nonlinear.snapshot().organs[0]!.parameters).toEqual(materials.materials[0]);
      nonlinear.releaseToolContact();advance(nonlinear,12);expect(Math.hypot(...nonlinear.toolSnapshot()!.displacementMm)).toBeLessThan(.003);
    }
  });
  it("retains fixed-step replay, coincident vertices and analytic anchor agreement with cached footprints",()=>{
    const a=new WholeScenePhysics(organs,materials,profile),b=new WholeScenePhysics(organs,materials,profile);
    const rest=new Float32Array([0,0,40,2,1,40,0,0,40]),binding=a.bind(rest),out=new Float32Array(rest.length);
    attach(a,7);attach(b,7);
    for(let frame=0;frame<30;frame++){
      a.step(.1,false);for(let step=0;step<12;step++)b.step(1/120,false);
      a.deform(rest,out,binding);expect(a.toolSnapshot()).toEqual(b.toolSnapshot());
      for(let v=0;v<3;v++)a.samplePoint(Array.from(rest.slice(v*3,v*3+3))).forEach((x,i)=>expect(out[v*3+i]).toBeCloseTo(x,5));
      expect(Array.from(out.slice(0,3))).toEqual(Array.from(out.slice(6,9)));
    }
    a.slideToolContact({mode:"push",organId:"liver",restPointMm:[2,1,40],normal:[0,0,1],targetPointMm:[2,1,36],radiusMm:6});advance(a,.3);a.deform(rest,out,binding);
    a.samplePoint([2,1,40]).forEach((x,i)=>expect(out[3+i]).toBeCloseTo(x,5));
    a.reset();a.deform(rest,out,binding);expect(out).toEqual(rest);
  });
  it("rejects invalid extensions before applying any tissue assignment",()=>{
    expect(()=>new WholeScenePhysics(organs,materials,{liver:{...profile.liver,strainStiffening:-1}})).toThrow();
    expect(()=>new WholeScenePhysics(organs,materials,{liver:{...profile.liver,localDampingRatio:NaN}})).toThrow();
    expect(()=>new WholeScenePhysics(organs,materials,{unknown:profile.liver})).toThrow();
  });
});

describe("supported cavity lining", () => {
  it("keeps the enclosing boundary still under breathing while allowing a recoverable local indentation", () => {
    const id = "abdominal-wall";
    const wallOrgans: ScenePhysicsOrgan[] = [{ id, category: "connective", bounds: { min: [-300, -300, -250], max: [300, 300, 250] } }];
    const wallMaterials: LearnedSceneMaterials = { ...materials, materials: [{ ...materials.materials[0]!, id, young_pa: 17500 }] };
    const solver = new WholeScenePhysics(wallOrgans, wallMaterials, { [id]: { strainStiffening: 36, localDampingRatio: 1.05, supportRadiusRatio: .3, fixedGlobalSupport: true } }, []);
    for (let i = 0; i < 240; i++) solver.step(1 / 60, true);
    expect(solver.snapshot().displacement_mm).toBe(0);
    const anchor = [0, 0, 200];
    solver.beginToolContact({ mode: "push", organId: id, restPointMm: anchor, normal: [0, 0, -1], targetPointMm: [0, 0, 204], radiusMm: 6 });
    advance(solver, .8);
    expect(solver.toolSnapshot()!.normalForceN).toBeGreaterThan(.1);
    expect(solver.toolSnapshot()!.displacementMm[2]).toBeGreaterThan(.5);
    expect(solver.snapshot().organs[0]!.displacement_mm).toEqual([0, 0, 0]);
    expect(solver.samplePoint([100, 0, 200], id)).toEqual([100, 0, 200]);
    solver.releaseToolContact(); advance(solver, 8);
    expect(solver.snapshot().displacement_mm).toBeLessThan(.003);
  });
});
