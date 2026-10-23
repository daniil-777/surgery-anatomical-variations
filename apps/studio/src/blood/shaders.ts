import { boundaryState, type BloodScene } from "./scene";
import { trayGeometry } from "./boundary";

/** Specialize immutable scene constants; uniforms below only select sort stages. */
export function solverShader(s: BloodScene, skipInactive = true, optimizedSort = false, compactPressure = false): string {
  const n = s.axis ** 3, bounded = s.fixture === "dam", boundaryCount = boundaryState(s).length / 4;
  const contact = bounded && s.wallContact === "unilateral-slip";
  const tray = trayGeometry(s);
  const total = n + boundaryCount, sorted = 2 ** Math.ceil(Math.log2(total));
  const cells = bounded ? s.axis : s.axis / 2, groups = Math.ceil(n / 64);
  const f = (v: number) => `${Math.fround(v).toExponential(10)}`;
  const contactProjection = contact ? `
      // Static planes, slip contact, zero restitution. Project velocity only;
      // the following pressure residual observes this constrained velocity.
      let p=C.p[i].xyz;
      let lower=min(vec3<f32>(0.),(vec3<f32>(${f(tray.minimumCentre)})-p)/DT);
      let upper=max(vec3<f32>(0.),(vec3<f32>(${f(tray.maximumCentre)})-p)/DT);
      let projected=max(v,lower);
      let next=vec3<f32>(min(projected.x,upper.x),projected.y,min(projected.z,upper.z));
      let change=length(next-v);
      if(change>1e-9){atomicAdd(&K[16],1u);atomicMax(&K[18],bitcast<u32>(change));}
      v=next;
  ` : "";
  const neighbor = (body: string) => `
    let cell = vec3<i32>(floor(C.p[i].xyz / H));
    for (var z = -1; z <= 1; z++) { for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
      ${bounded ? `let c = cell + vec3<i32>(x,y,z);
      if(any(c<vec3<i32>(0)) || any(c>=vec3<i32>(GRID))){continue;}` : "let c = (cell + vec3<i32>(x,y,z) + vec3<i32>(GRID)) % vec3<i32>(GRID);"}
      let key = u32(c.x + GRID * (c.y + GRID * c.z));
      for (var a = S.starts[key]; a < S.ends[key]; a++) {
        let j = S.pairs[a].y;
        var r = C.p[i].xyz - position(j).xyz;
        ${bounded ? "" : "r -= round(r / L) * L;"}
        let r2 = dot(r,r);
        if (r2 < H * H) { let grad = gradient(r, r2); let m = position(j).w; ${body} }
      }
    }}}`;
  const coefficient = (name: string, v: string, density: boolean) => `
    @compute @workgroup_size(64) fn ${name}(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i = gid.x; if (i >= N || stopped()) {return;}
      ${skipInactive ? `if(atomicLoad(&K[${density ? 2 : 3}])==0u){return;}` : ""}
      var rate = 0.0;
      ${neighbor(`rate += m * dot(${v}[i].xyz - velocity(j), grad);`)}
      var error = ${density ? "(W.rhoFactor[i].x + DT * rate - RHO)" : "rate"};
      ${bounded ? `error=max(error,0.0); ${density ? "" : "if(W.rhoFactor[i].z<20.0){error=0.0;}"} ` : ""}
      W.residual[i] = ${density ? "abs(error) / RHO" : "abs(error) / max(W.rhoFactor[i].x, 1.0)"};
      W.coeff[i] = error / (${density ? "DT * " : ""}max(W.rhoFactor[i].y, 1e-6));
    }`;
  const correct = (name: string, from: string, to: string, active: number) => `
    @compute @workgroup_size(64) fn ${name}(@builtin(global_invocation_id) gid: vec3<u32>) {
      let i = gid.x; if (i >= N || stopped()) {return;}
      ${skipInactive ? `if(atomicLoad(&K[${active}])==0u){return;}` : ""}
      var v = ${from}[i].xyz;
      if (atomicLoad(&K[${active}]) != 0u) {
        var correction = vec3<f32>(0.0);
        ${neighbor(`correction += m * (W.coeff[i] + coefficient(j)) * grad;`)}
        v -= 0.5 * correction; // Relaxed Jacobi; physical force scaling is unchanged at convergence.
      }
      if (any(abs(v) > vec3<f32>(1.0))) { atomicOr(&K[5], 4u); return; }
      ${compactPressure ? `
      // Correction gathers neighbour coefficients and positions, never their
      // velocities. Each lane therefore owns its C.v write without a race.
      ${contactProjection}
      C.v[i]=vec4<f32>(v,0.); W.v[i]=C.v[i];
      ` : `${to}[i] = vec4<f32>(v, 0.0);`}
    }`;
  const compactGate = (kind: "density" | "divergence", active: number, residual: number, evaluations: number, tolerance: number) => `
    @compute @workgroup_size(64) fn ${kind}ReduceGate(@builtin(local_invocation_id) lid:vec3<u32>) {
      // One workgroup strides all residuals: the global maximum has no
      // floating-point summation or rounding-order dependence.
      var value=0.0;
      for(var i=lid.x;i<N;i+=64u){value=max(value,W.residual[i]);}
      reduction[lid.x]=value; workgroupBarrier();
      for(var stride=32u;stride>0u;stride/=2u){
        if(lid.x<stride){reduction[lid.x]=max(reduction[lid.x],reduction[lid.x+stride]);}
        workgroupBarrier();
      }
      // All lanes reach every barrier, even when the attempt was rejected.
      if(lid.x==0u && !stopped()){
        let v=reduction[0]; atomicStore(&K[${residual}],bitcast<u32>(v));
        if(atomicLoad(&K[${active}])!=0u){atomicAdd(&K[${evaluations}],1u);}
        if(v<=${f(tolerance)}){atomicStore(&K[${active}],0u);}
      }
    }`;
  return `
const N = ${n}u; const TOTAL = ${total}u; const SORT = ${sorted}u; const GRID = ${cells}; const GROUPS = ${groups}u;
const H = ${f(s.lengthM / cells)}; const L = ${f(s.lengthM)};
const RHO = ${f(s.densityKgM3)}; const DT = ${f(s.dtSeconds)};
const NU = ${f(s.dynamicViscosityPaS / s.densityKgM3)}; const PI = 3.141592653589793;
struct State { p: array<vec4<f32>, ${n}>, v: array<vec4<f32>, ${n}> }
struct Work {
  v: array<vec4<f32>, ${n}>, rhoFactor: array<vec4<f32>, ${n}>,
  coeff: array<f32, ${n}>, residual: array<f32, ${n}>, maxima: array<f32, ${groups}>
}
struct Spatial { pairs: array<vec2<u32>, ${sorted}>, starts: array<u32, ${cells ** 3}>, ends: array<u32, ${cells ** 3}> }
@group(0) @binding(0) var<storage, read_write> A: State;
@group(0) @binding(1) var<storage, read_write> C: State;
@group(0) @binding(2) var<storage, read_write> W: Work;
@group(0) @binding(3) var<storage, read_write> S: Spatial;
@group(0) @binding(4) var<storage, read_write> K: array<atomic<u32>, 64>;
@group(0) @binding(5) var<uniform> sortStage: vec4<u32>;
// IDs are independent u32 values, immutable after reset. Canonical state is never reordered.
@group(0) @binding(6) var<storage, read> ids: array<u32>;
@group(0) @binding(7) var<storage, read> boundary: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> neighborBits: array<u32>;
fn position(j:u32) -> vec4<f32> {if(j<N){return C.p[j];} return boundary[j-N];}
fn velocity(j:u32) -> vec3<f32> {if(j<N){return C.v[j].xyz;} return vec3<f32>(0.0);}
fn coefficient(j:u32) -> f32 {if(j<N){return W.coeff[j];} return 0.0;}
fn stopped() -> bool { return atomicLoad(&K[0]) != 0u || atomicLoad(&K[5]) != 0u; }
fn weight(r: f32) -> f32 {
 let q = r/H; let k = 8.0/(PI*H*H*H);
 if (q > 0.5) {return k*2.0*pow(1.0-q,3.0);} return k*(1.0-6.0*q*q+6.0*q*q*q);
}
fn gradient(r: vec3<f32>, r2: f32) -> vec3<f32> {
 if (r2 < 1e-20) {return vec3<f32>(0.0);}
 let d = sqrt(r2); let q = d/H; let k = 8.0/(PI*H*H*H*H);
 var value = 18.0*q*q-12.0*q;
 if (q > 0.5) {value = -6.0*(1.0-q)*(1.0-q);}
 return r*(k*value/d);
}
@compute @workgroup_size(1) fn begin() {
 if (atomicLoad(&K[0]) != 0u) {return;}
 atomicStore(&K[5],0u); atomicAdd(&K[4],1u);
 atomicStore(&K[2],1u); atomicStore(&K[3],1u);
 atomicStore(&K[10],0u); atomicStore(&K[11],0u);
 atomicStore(&K[15],0u);
 atomicStore(&K[16],0u); atomicStore(&K[18],0u);
 if (atomicLoad(&K[1]) >= 10000000u) {atomicOr(&K[5],8u);}
}
@compute @workgroup_size(64) fn seed(@builtin(global_invocation_id) gid: vec3<u32>) {
 let i = gid.x; if(i>=N || stopped()){return;} C.p[i]=A.p[i]; C.v[i]=A.v[i];
}
@compute @workgroup_size(64) fn keys(@builtin(global_invocation_id) gid: vec3<u32>) {
 let i=gid.x; if(i>=SORT || stopped()){return;}
 if(i>=TOTAL){ S.pairs[i]=vec2<u32>(0xffffffffu); return; }
 let p=position(i).xyz;
 if(any(p<vec3<f32>(0.0)) || any(p>=vec3<f32>(L))) {atomicOr(&K[5],2u); return;}
 let c=vec3<u32>(floor(p/H));
 S.pairs[i]=vec2<u32>(c.x+u32(GRID)*(c.y+u32(GRID)*c.z), i);
}
@compute @workgroup_size(64) fn sort(@builtin(global_invocation_id) gid: vec3<u32>) {
 let i=gid.x; if(i>=SORT || stopped()){return;}
 let j=i^sortStage.x; if(j<=i){return;}
 let a=S.pairs[i]; let b=S.pairs[j];
 let greater=(a.x>b.x) || (a.x==b.x && a.y>b.y);
 if(greater == ((i&sortStage.y)==0u)){S.pairs[i]=b; S.pairs[j]=a;}
}
${optimizedSort ? `
// Exactly the first 36 global bitonic stages, performed in 2 KiB of shared
// memory. Adjacent 256-element tiles finish in opposite directions so that
// the unchanged global stages beginning at k=512 can merge them.
var<workgroup> sortTile: array<vec2<u32>,256>;
@compute @workgroup_size(128) fn sortLocal(@builtin(local_invocation_id) lid:vec3<u32>,
 @builtin(workgroup_id) wid:vec3<u32>) {
 let base=wid.x*256u;
 let enabled=!stopped();
 // SORT is a power of two >=512 for every validated scene. Guarded loads also
 // keep this entry point safe if a future scene has a shorter final tile.
 var a=vec2<u32>(0xffffffffu); var b=vec2<u32>(0xffffffffu);
 if(enabled && base+lid.x<SORT){a=S.pairs[base+lid.x];}
 if(enabled && base+lid.x+128u<SORT){b=S.pairs[base+lid.x+128u];}
 sortTile[lid.x]=a; sortTile[lid.x+128u]=b;
 workgroupBarrier();
 for(var k=2u;k<=256u;k*=2u){
  for(var j=k/2u;j>0u;j/=2u){
   // Each lane owns one disjoint comparator pair. All lanes reach every
   // barrier, including rejected attempts; no storage-dependent early exit.
   let i=(lid.x/j)*(2u*j)+(lid.x%j);
   let other=i+j;
   let left=sortTile[i]; let right=sortTile[other];
   let greater=(left.x>right.x) || (left.x==right.x && left.y>right.y);
   if(greater == (((base+i)&k)==0u)){sortTile[i]=right;sortTile[other]=left;}
   workgroupBarrier();
  }
 }
 if(enabled && base+lid.x<SORT){S.pairs[base+lid.x]=sortTile[lid.x];}
 if(enabled && base+lid.x+128u<SORT){S.pairs[base+lid.x+128u]=sortTile[lid.x+128u];}
}
// After the global j>=256 stages of a merge with k>=512, all remaining
// comparator partners belong to the same tile. Replace only j=128..1 here;
// the enclosing global k still determines each comparator's direction.
@compute @workgroup_size(128) fn sortLocalMerge(@builtin(local_invocation_id) lid:vec3<u32>,
 @builtin(workgroup_id) wid:vec3<u32>) {
 let base=wid.x*256u;
 let enabled=!stopped();
 var a=vec2<u32>(0xffffffffu); var b=vec2<u32>(0xffffffffu);
 if(enabled && base+lid.x<SORT){a=S.pairs[base+lid.x];}
 if(enabled && base+lid.x+128u<SORT){b=S.pairs[base+lid.x+128u];}
 sortTile[lid.x]=a; sortTile[lid.x+128u]=b;
 workgroupBarrier();
 for(var j=128u;j>0u;j/=2u){
  let i=(lid.x/j)*(2u*j)+(lid.x%j);
  let other=i+j;
  let left=sortTile[i]; let right=sortTile[other];
  let greater=(left.x>right.x) || (left.x==right.x && left.y>right.y);
  if(greater == (((base+i)&sortStage.y)==0u)){sortTile[i]=right;sortTile[other]=left;}
  workgroupBarrier();
 }
 if(enabled && base+lid.x<SORT){S.pairs[base+lid.x]=sortTile[lid.x];}
 if(enabled && base+lid.x+128u<SORT){S.pairs[base+lid.x+128u]=sortTile[lid.x+128u];}
}
` : ""}
@compute @workgroup_size(64) fn clearRanges(@builtin(global_invocation_id) gid: vec3<u32>) {
 if(gid.x < ${cells ** 3}u) {S.starts[gid.x]=0u;S.ends[gid.x]=0u;}
}
@compute @workgroup_size(64) fn ranges(@builtin(global_invocation_id) gid: vec3<u32>) {
 let i=gid.x; if(i>=TOTAL || stopped()){return;} let key=S.pairs[i].x;
 // Separate scalar arrays: never concurrently write components of a vector.
 if(i==0u){S.starts[key]=0u;} else if(S.pairs[i-1u].x!=key){S.starts[key]=i;}
 if(i==TOTAL-1u){S.ends[key]=TOTAL;} else if(S.pairs[i+1u].x!=key){S.ends[key]=i+1u;}
}
@compute @workgroup_size(64) fn geometry(@builtin(global_invocation_id) gid: vec3<u32>) {
 let i=gid.x; if(i>=N || stopped()){return;}
 var rho=0.0; var g=vec3<f32>(0.0); var denom=0.0; var degree=0u;
 ${neighbor(`rho += m * weight(sqrt(r2)); let mg=m*grad; g+=mg; if(j<N){denom+=dot(mg,mg);} degree++;`)}
 W.rhoFactor[i]=vec4<f32>(rho,denom+dot(g,g),f32(degree),0.0);
}
@compute @workgroup_size(64) fn neighborProbe(@builtin(global_invocation_id) gid: vec3<u32>) {
 let i=gid.x; let words=(TOTAL+31u)/32u;
 if(i>=N || (i+1u)*words>arrayLength(&neighborBits) || stopped()){return;}
 for(var k=0u;k<words;k++){neighborBits[i*words+k]=0u;}
 ${neighbor(`neighborBits[i*words+j/32u] |= 1u<<(j%32u);`)}
}
@compute @workgroup_size(64) fn predict(@builtin(global_invocation_id) gid: vec3<u32>) {
 let i=gid.x; if(i>=N || stopped()){return;}
 var accel=vec3<f32>(0.0,${bounded ? "-9.81" : "0.0"},0.0);
 // Constant Newtonian viscosity, central pair form in 3D. No XSPH damping or CY substitution.
 ${neighbor(`accel += (10.0*NU*m/RHO) * dot(C.v[i].xyz-velocity(j),r)/(r2+0.01*H*H) * grad;`)}
 W.v[i]=vec4<f32>(C.v[i].xyz+DT*accel,0.0);
}
@compute @workgroup_size(64) fn copyVelocity(@builtin(global_invocation_id) gid: vec3<u32>) {
 let i=gid.x; if(i>=N || stopped()){return;}
 var v=W.v[i].xyz;
 ${contactProjection}
 C.v[i]=vec4<f32>(v,0.); W.v[i]=C.v[i];
}
${coefficient("densityResidual", "C.v", true)}
${coefficient("divergenceResidual", "C.v", false)}
${correct("densityCorrect", "C.v", "W.v", 2)}
${correct("divergenceCorrect", "C.v", "W.v", 3)}
var<workgroup> reduction: array<f32,64>;
@compute @workgroup_size(64) fn reduce(@builtin(global_invocation_id) gid: vec3<u32>,
 @builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
 var value=0.0; if(gid.x<N){value=W.residual[gid.x];}
 reduction[lid.x]=value; workgroupBarrier();
 for(var stride=32u; stride>0u; stride/=2u){
  if(lid.x<stride){reduction[lid.x]=max(reduction[lid.x],reduction[lid.x+stride]);}
  workgroupBarrier();
 }
 if(lid.x==0u){W.maxima[wid.x]=reduction[0];}
}
fn maximum() -> f32 {var v=0.0; for(var i=0u;i<GROUPS;i++){v=max(v,W.maxima[i]);} return v;}
@compute @workgroup_size(1) fn densityGate() {
 if(stopped()){return;} let v=maximum(); atomicStore(&K[6],bitcast<u32>(v));
 if(atomicLoad(&K[2])!=0u){atomicAdd(&K[10],1u);}
 if(v<=${f(s.densityTolerance)}){atomicStore(&K[2],0u);}
}
@compute @workgroup_size(1) fn divergenceGate() {
 if(stopped()){return;} let v=maximum(); atomicStore(&K[7],bitcast<u32>(v));
 if(atomicLoad(&K[3])!=0u){atomicAdd(&K[11],1u);}
 if(v<=${f(s.divergenceToleranceS)}){atomicStore(&K[3],0u);}
}
${compactPressure ? compactGate("density", 2, 6, 10, s.densityTolerance) + compactGate("divergence", 3, 7, 11, s.divergenceToleranceS) : ""}
@compute @workgroup_size(1) fn endDensity() {if(atomicLoad(&K[2])!=0u){atomicOr(&K[5],16u);}}
@compute @workgroup_size(64) fn advect(@builtin(global_invocation_id) gid: vec3<u32>) {
 let i=gid.x; if(i>=N || stopped()){return;}
 let displacement=DT*C.v[i].xyz;
 if(length(displacement)>0.1*H){atomicOr(&K[5],4u);return;}
 var p=C.p[i].xyz+displacement;
 ${bounded ? `if(p.y>=L){atomicOr(&K[5],512u);return;}
 if(p.y<${contact ? f(tray.minimumCentre - 1e-7 * s.lengthM) : "0.75*H"} || p.x<${contact ? f(tray.minimumCentre - 1e-7 * s.lengthM) : "0.75*H"} || p.z<${contact ? f(tray.minimumCentre - 1e-7 * s.lengthM) : "0.75*H"} || p.x>${contact ? f(tray.maximumCentre + 1e-7 * s.lengthM) : "L-0.75*H"} || p.z>${contact ? f(tray.maximumCentre + 1e-7 * s.lengthM) : "L-0.75*H"}){
 atomicOr(&K[5],256u);return;}` : "p-=floor(p/L)*L;"}
 C.p[i]=vec4<f32>(min(p,vec3<f32>(L*(1.0-1e-7))),C.p[i].w);
}
@compute @workgroup_size(64) fn finalGuard(@builtin(global_invocation_id) gid: vec3<u32>) {
 let i=gid.x; if(i>=N || stopped()){return;}
 let error=${bounded ? "max" : "abs"}(W.rhoFactor[i].x/RHO-1.0${bounded ? ",0.0" : ""});
 atomicMax(&K[15],bitcast<u32>(error));
 if(error>0.01){atomicOr(&K[5],32u);}
}
@compute @workgroup_size(1) fn decide() {
 if(atomicLoad(&K[5])==0u && atomicLoad(&K[3])!=0u){atomicOr(&K[5],64u);}
 if(atomicLoad(&K[5])!=0u){atomicStore(&K[0],1u);}
}
@compute @workgroup_size(64) fn commit(@builtin(global_invocation_id) gid: vec3<u32>) {
 let i=gid.x; if(i<N && !stopped()){A.p[i]=C.p[i]; A.v[i]=C.v[i];}
}
@compute @workgroup_size(1) fn publish() {
 if(!stopped()){
 atomicAdd(&K[1],1u); atomicAdd(&K[9],1u);
 atomicMax(&K[13],atomicLoad(&K[15])); atomicMax(&K[14],atomicLoad(&K[7]));
 atomicAdd(&K[17],atomicLoad(&K[16])); atomicMax(&K[19],atomicLoad(&K[18]));
 }
}
// Explicit adversarial fixture entry point, never used in the interactive step path.
@compute @workgroup_size(1) fn rejectFixture() {atomicOr(&K[5],128u);}
`;
}

export const MATERIAL_SHADER = `
struct Sample { g0: vec4<f32>, g1: vec4<f32>, g2: vec4<f32> }
@group(0) @binding(0) var<storage,read> gradients: array<Sample>;
@group(0) @binding(1) var<storage,read_write> results: array<vec4<f32>>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {
 if(id.x>=arrayLength(&gradients)){return;}
 let g=gradients[id.x];
 let d=mat3x3<f32>(g.g0.xyz,g.g1.xyz,g.g2.xyz);
 let s=0.5*(d+transpose(d));
 let gamma=sqrt(2.0*(dot(s[0],s[0])+dot(s[1],s[1])+dot(s[2],s[2])));
 let mu1=0.00345+(0.056-0.00345)*pow(1.0+pow(1.902*gamma,1.25),(0.22-1.0)/1.25);
 let mu2=0.00345+(0.056-0.00345)*pow(1.0+pow(3.313*gamma,2.0),(0.3568-1.0)/2.0);
 results[id.x]=vec4<f32>(gamma,mu1,mu2,0.0);
}`;
