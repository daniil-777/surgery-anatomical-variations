import type { RankOneTerm } from './preconditioner';

/** Node IDs (not coordinate indices); row-major matrix on their3D coordinates.
 * The caller supplies symmetric positive-semidefinite continuum blocks. This
 * helper validates layout/symmetry, not eigenvalues of arbitrary user matrices. */
export interface NodalBlock { ids: number[]; values: Float64Array }
const dot=(a:Float64Array,b:Float64Array)=>{let sum=0;for(let i=0;i<a.length;i++)sum+=a[i]!*b[i]!;return sum;};

/** Fixed SPD preconditioner operator. Assemble sparse3×3 blocks once; apply
 * block-Jacobi PCG with the same96-iteration/1e-4 relative residual ceiling as
 * the existing rank operator. Exact energy/gradients/acceptance live elsewhere.
 * Inputs are copied; outputs own their storage. Private scratch is synchronous
 * and non-reentrant. Approximate inverse failure falls back to SPD Jacobi.
 */
export function sparseBlockPreconditioner(baseDiagonal:Float64Array,blocks:readonly NodalBlock[],terms:readonly RankOneTerm[]){
  if(!baseDiagonal.length||baseDiagonal.length%3||baseDiagonal.some(v=>!Number.isFinite(v)||v<=0))throw new Error('Positive finite3D base diagonal required');
  const count=baseDiagonal.length/3, rows=Array.from({length:count},()=>new Map<number,Float64Array>());
  const get=(row:number,col:number)=>{let block=rows[row]!.get(col);if(!block){block=new Float64Array(9);rows[row]!.set(col,block);}return block;};
  for(let i=0;i<count;i++)for(let axis=0;axis<3;axis++)get(i,i)[4*axis]=baseDiagonal[3*i+axis]!;
  for(const block of blocks){
    const n=3*block.ids.length;
    if(!block.ids.length||new Set(block.ids).size!==block.ids.length||block.ids.some(id=>!Number.isInteger(id)||id<0||id>=count)||block.values.length!==n*n||block.values.some(v=>!Number.isFinite(v)))throw new Error('Invalid finite nodal block');
    for(let r=0;r<n;r++)for(let c=r+1;c<n;c++){
      const a=block.values[n*r+c]!,b=block.values[n*c+r]!;
      if(Math.abs(a-b)>1e-12*Math.max(1,Math.abs(a),Math.abs(b)))throw new Error('Symmetric nodal block required');
    }
    for(let i=0;i<block.ids.length;i++)for(let j=0;j<block.ids.length;j++){
      const target=get(block.ids[i]!,block.ids[j]!);
      for(let r=0;r<3;r++)for(let c=0;c<3;c++){
        const row=3*i+r,col=3*j+c;
        // Only roundoff-sized input asymmetry is averaged, preserving symmetry
        // of the represented quadratic form and the PCG operator.
        target[3*r+c]!+=.5*(block.values[n*row+col]!+block.values[n*col+row]!);
      }
    }
  }
  for(const term of terms){
    if(!Number.isFinite(term.stiffness)||term.stiffness<0||term.indices.length!==term.coefficients.length||term.indices.some(id=>!Number.isInteger(id)||id<0||id>=baseDiagonal.length)||term.coefficients.some(v=>!Number.isFinite(v)))throw new Error('Invalid nonnegative rank term');
    if(term.stiffness===0)continue;
    for(let i=0;i<term.indices.length;i++)for(let j=0;j<term.indices.length;j++){
      const row=term.indices[i]!,col=term.indices[j]!;
      get(Math.floor(row/3),Math.floor(col/3))[3*(row%3)+col%3]!+=(term.coefficients[i]!*term.coefficients[j]!)*term.stiffness;
    }
  }
  const rowPointers=new Uint32Array(count+1);
  for(let i=0;i<count;i++)rowPointers[i+1]=rowPointers[i]!+rows[i]!.size;
  const columns=new Uint32Array(rowPointers[count]!),sourceOffsets=new Uint32Array(rowPointers[count]!),values=new Float64Array(9*columns.length),diagonal=new Float64Array(baseDiagonal.length),inverseBlocks=new Float64Array(6*count);
  let jacobiFallbackBlocks=0;
  for(let i=0;i<count;i++){
    const sorted=[...rows[i]!.keys()].sort((a,b)=>a-b);
    for(let j=0;j<sorted.length;j++){const at=rowPointers[i]!+j,col=sorted[j]!;columns[at]=col;sourceOffsets[at]=3*col;values.set(rows[i]!.get(col)!,9*at);}
    const d=rows[i]!.get(i)!;for(let r=0;r<3;r++)diagonal[3*i+r]=d[4*r]!;
    if(d.some(v=>!Number.isFinite(v))||[d[0]!,d[4]!,d[8]!].some(v=>v<=0))throw new Error('Nonfinite or nonpositive assembled diagonal');
    const l00=Math.sqrt(d[0]!),l10=d[3]!/l00,l20=d[6]!/l00,l11=Math.sqrt(d[4]!-l10*l10),l21=(d[7]!-l20*l10)/l11,l22=Math.sqrt(d[8]!-l20*l20-l21*l21);
    const offset=6*i;
    if([l00,l11,l22].every(v=>Number.isFinite(v)&&v>0)&&Number.isFinite(l21)){
      const a=1/l00,b=-l10/(l00*l11),c=(l10*l21-l20*l11)/(l00*l11*l22),d0=1/l11,e=-l21/(l11*l22),f=1/l22;
      inverseBlocks[offset]=a*a+b*b+c*c;inverseBlocks[offset+1]=b*d0+c*e;inverseBlocks[offset+2]=c*f;
      inverseBlocks[offset+3]=d0*d0+e*e;inverseBlocks[offset+4]=e*f;inverseBlocks[offset+5]=f*f;
    }else{
      // Extreme conditioning can erase the strictly positive base at machine
      // precision. Scalar Jacobi remains an owned, finite descent fallback.
      inverseBlocks[offset]=1/d[0]!;inverseBlocks[offset+3]=1/d[4]!;inverseBlocks[offset+5]=1/d[8]!;jacobiFallbackBlocks++;
    }
  }
  if(values.some(v=>!Number.isFinite(v))||inverseBlocks.some(v=>!Number.isFinite(v)))throw new Error('Sparse operator overflow');
  const multiplyInto=(input:Float64Array,output:Float64Array)=>{
    for(let row=0;row<count;row++){
      let x=0,y=0,z=0;
      for(let entry=rowPointers[row]!;entry<rowPointers[row+1]!;entry++){
        const source=sourceOffsets[entry]!,offset=9*entry,a=input[source]!,b=input[source+1]!,c=input[source+2]!;
        x+=values[offset]!*a+values[offset+1]!*b+values[offset+2]!*c;
        y+=values[offset+3]!*a+values[offset+4]!*b+values[offset+5]!*c;
        z+=values[offset+6]!*a+values[offset+7]!*b+values[offset+8]!*c;
      }
      output[3*row]=x;output[3*row+1]=y;output[3*row+2]=z;
    }
  };
  const jacobi=(input:Float64Array,output:Float64Array)=>{
    for(let i=0;i<count;i++){
      const o=6*i,a=input[3*i]!,b=input[3*i+1]!,c=input[3*i+2]!;
      output[3*i]=inverseBlocks[o]!*a+inverseBlocks[o+1]!*b+inverseBlocks[o+2]!*c;
      output[3*i+1]=inverseBlocks[o+1]!*a+inverseBlocks[o+3]!*b+inverseBlocks[o+4]!*c;
      output[3*i+2]=inverseBlocks[o+2]!*a+inverseBlocks[o+4]!*b+inverseBlocks[o+5]!*c;
    }
  };
  const validate=(input:Float64Array)=>{if(input.length!==baseDiagonal.length||input.some(v=>!Number.isFinite(v)))throw new Error('Finite preconditioner vector of matching size required');};
  const multiply=(input:Float64Array)=>{validate(input);const output=new Float64Array(input.length);multiplyInto(input,output);if(output.some(v=>!Number.isFinite(v)))throw new Error('Sparse product overflow');return output;};
  const r=new Float64Array(baseDiagonal.length),p=new Float64Array(baseDiagonal.length),hp=new Float64Array(baseDiagonal.length),z=new Float64Array(baseDiagonal.length);
  const applyInverse=(input:Float64Array)=>{
    validate(input);const output=new Float64Array(input.length);r.set(input);jacobi(r,p);let rz=dot(r,p);const norm=dot(input,input);if(norm===0)return output;
    for(let iteration=0;iteration<96;iteration++){
      multiplyInto(p,hp);const denominator=dot(p,hp);if(!(denominator>0)||!Number.isFinite(denominator))break;
      const alpha=rz/denominator;for(let i=0;i<output.length;i++){output[i]!+=alpha*p[i]!;r[i]!-=alpha*hp[i]!;}
      if(dot(r,r)<1e-8*norm)break;
      jacobi(r,z);const next=dot(r,z),beta=next/rz;
      for(let i=0;i<p.length;i++)p[i]=z[i]!+beta*p[i]!;rz=next;
    }
    if(output.some(v=>!Number.isFinite(v))||!(dot(output,input)>0))jacobi(input,output);
    if(output.some(v=>!Number.isFinite(v)))throw new Error('Sparse inverse overflow');
    return output;
  };
  return{diagonal:diagonal.slice(),multiply,applyInverse,diagnostics:Object.freeze({nodes:count,storedBlocks:columns.length,jacobiFallbackBlocks})};
}
