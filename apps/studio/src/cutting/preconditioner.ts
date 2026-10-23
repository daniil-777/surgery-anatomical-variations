export interface RankOneTerm { indices:number[]; coefficients:Float64Array; stiffness:number }
// Preserve the original left-to-right summation order without a callback in
// every inner iteration. No compensated sum or convergence change is applied.
const dot=(a:Float64Array,b:Float64Array)=>{let sum=0;for(let i=0;i<a.length;i++)sum+=a[i]!*b[i]!;return sum;};

/** SPD approximation: positive lumped inertia/bulk plus contact Gram terms and
 * cohesive pair blocks. No dense global matrix or shared-material changes. */
export function rankOnePreconditioner(base:Float64Array,terms:RankOneTerm[]){
  if(base.some(v=>!Number.isFinite(v)||v<=0)||terms.some(t=>!Number.isFinite(t.stiffness)||t.stiffness<0||t.indices.length!==t.coefficients.length||t.coefficients.some(v=>!Number.isFinite(v))||t.indices.some(i=>!Number.isInteger(i)||i<0||i>=base.length)))throw new Error("Positive finite preconditioner required");
  const diagonal=base.slice();for(const t of terms)t.indices.forEach((id,j)=>{diagonal[id]!+=t.stiffness*t.coefficients[j]!**2;});
  const multiplyInto=(input:Float64Array,output:Float64Array)=>{
    for(let i=0;i<input.length;i++)output[i]=input[i]!*base[i]!;
    for(const t of terms){let projection=0;for(let j=0;j<t.indices.length;j++)projection+=t.coefficients[j]!*input[t.indices[j]!]!;projection*=t.stiffness;for(let j=0;j<t.indices.length;j++)output[t.indices[j]!]!+=projection*t.coefficients[j]!;}
  };
  const multiply=(input:Float64Array)=>{
    if(input.length!==base.length)throw new Error("Preconditioner vector size mismatch");
    const output=new Float64Array(input.length);multiplyInto(input,output);
    return output;
  };
  // One inverse is used synchronously by one solver. Scratch remains private;
  // returned vectors are newly owned so later solves cannot mutate L-BFGS data.
  const r=new Float64Array(base.length),p=new Float64Array(base.length),hp=new Float64Array(base.length),z=new Float64Array(base.length);
  const applyInverse=(input:Float64Array)=>{
    if(input.length!==base.length)throw new Error("Preconditioner vector size mismatch");
    const output=new Float64Array(input.length);r.set(input);
    for(let i=0;i<input.length;i++)p[i]=r[i]!/diagonal[i]!;
    let rz=dot(r,p);const norm=dot(input,input);if(norm===0)return output;
    for(let iteration=0;iteration<96;iteration++){
      multiplyInto(p,hp);const denominator=dot(p,hp);if(!(denominator>0)||!Number.isFinite(denominator))break;
      const alpha=rz/denominator;for(let i=0;i<output.length;i++){output[i]!+=alpha*p[i]!;r[i]!-=alpha*hp[i]!;}
      if(dot(r,r)<1e-8*norm)break;
      for(let i=0;i<r.length;i++)z[i]=r[i]!/diagonal[i]!;
      const next=dot(r,z),beta=next/rz;
      for(let i=0;i<p.length;i++)p[i]=z[i]!+beta*p[i]!;rz=next;
    }
    return output;
  };
  return {diagonal,applyInverse,multiply};
}
