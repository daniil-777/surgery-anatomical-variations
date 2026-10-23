import { CUTTING_NUMERICS } from "./numerics";
export interface IncrementalEvaluation { energy: number; gradient: Float64Array; minimumJacobian: number }
const dot=(a:Float64Array,b:Float64Array)=>{let sum=0;for(let i=0;i<a.length;i++)sum+=a[i]!*b[i]!;return sum;};

/** Bounded preconditioned L-BFGS on a frozen-history incremental potential.
 * Every trial uses the exact global energy. Rejected lines restore positions;
 * no state/history is owned or committed here. Projection handles the floor. */
export function minimizeIncremental(x:Float64Array,evaluate:()=>IncrementalEvaluation,diagonal:Float64Array,floor:number,budget=48,applyInverse?:(input:Float64Array)=>Float64Array):number {
  const history:{s:Float64Array;y:Float64Array;rho:number}[]=[];
  let current=evaluate(),completed=0;
  for(let iteration=0;iteration<budget;iteration++){
    if(!Number.isFinite(current.energy)||!current.gradient.every(Number.isFinite)||current.minimumJacobian<=CUTTING_NUMERICS.minimumTrialJacobian)break;
    let maxResidual=0;for(let i=0;i<x.length;i+=3)maxResidual=Math.max(maxResidual,Math.hypot(current.gradient[i]!,current.gradient[i+1]!,current.gradient[i+2]!));
    if(maxResidual<CUTTING_NUMERICS.globalTargetResidualN)break;
    const q=current.gradient.slice(),alpha=new Float64Array(history.length);
    for(let j=history.length-1;j>=0;j--){const pair=history[j]!;alpha[j]=pair.rho*dot(pair.s,q);for(let i=0;i<q.length;i++)q[i]!-=alpha[j]!*pair.y[i]!;}
    const direction=applyInverse?applyInverse(q):Float64Array.from(q,(v,i)=>v/diagonal[i]!);
    for(let j=0;j<history.length;j++){const pair=history[j]!,beta=pair.rho*dot(pair.y,direction);for(let i=0;i<direction.length;i++)direction[i]!+=pair.s[i]!*(alpha[j]!-beta);}
    for(let i=0;i<direction.length;i++)direction[i]=-direction[i]!;
    if(!(dot(direction,current.gradient)<0)){
      history.length=0;for(let i=0;i<direction.length;i++)direction[i]=-current.gradient[i]!/diagonal[i]!;
    }
    const old=x.slice();let accepted:IncrementalEvaluation|null=null;
    for(let line=0;line<16;line++){
      const scale=2**-line;let directional=0;
      for(let i=0;i<x.length;i++){x[i]=old[i]!+scale*direction[i]!;if(i%3===1)x[i]=Math.max(floor,x[i]!);directional+=current.gradient[i]!*(x[i]!-old[i]!);}
      const trial=evaluate();
      if(directional<0&&trial.minimumJacobian>CUTTING_NUMERICS.minimumTrialJacobian&&Number.isFinite(trial.energy)&&trial.gradient.every(Number.isFinite)&&trial.energy<=current.energy+1e-4*directional+1e-14){accepted=trial;break;}
    }
    if(!accepted){x.set(old);break;}
    const s=Float64Array.from(x,(v,i)=>v-old[i]!),y=Float64Array.from(accepted.gradient,(v,i)=>v-current.gradient[i]!),curvature=dot(s,y);
    if(curvature>1e-12*Math.sqrt(dot(s,s)*dot(y,y))&&curvature>1e-20){history.push({s,y,rho:1/curvature});if(history.length>10)history.shift();}
    current=accepted;completed++;
  }
  return completed;
}
