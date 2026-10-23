/** Allocation-bounded evaluator of the unchanged triangle integral.
 * The constructor snapshots/validates planes. Evaluation writes caller-owned
 * arrays; no returned array aliases internal polygon/distance scratch.
 */
import type {Plane,TriangleGramTerm} from './contactIntegral';
type V3=[number,number,number];
export class TrianglePenaltyScratch {
  private readonly planes: readonly Plane[];
  private readonly distances: Float64Array;
  private readonly first: Float64Array;
  private readonly second: Float64Array;
  constructor(planes:readonly Plane[], private readonly stiffness:number){
    if(!(stiffness>0)||!Number.isFinite(stiffness))throw Error('Positive finite stiffness required');
    if(!planes.length||planes.some(p=>p.normal.length!==3||!Number.isFinite(p.offset)||p.normal.some(v=>!Number.isFinite(v))||Math.abs(Math.hypot(...p.normal)-1)>1e-12))throw Error('Normalized finite blade halfspaces required');
    this.planes=planes.map(p=>({normal:[...p.normal] as V3,offset:p.offset}));
    this.distances=new Float64Array(planes.length*3);
    this.first=new Float64Array((planes.length+5)*3);this.second=new Float64Array(this.first.length);
  }
  private clip(input:Float64Array,count:number,a:number,b:number,c:number,output:Float64Array):number{
    let outputCount=0;
    for(let i=0;i<count;i++){
      const u=3*i,v=3*((i+1)%count);
      const x=input[u]!,y=input[u+1]!,z=input[u+2]!,xx=input[v]!,yy=input[v+1]!,zz=input[v+2]!;
      const da=x*a+y*b+z*c,db=xx*a+yy*b+zz*c;
      if(da>=0){const k=3*outputCount++;output[k]=x;output[k+1]=y;output[k+2]=z;}
      if((da<0&&db>0)||(da>0&&db<0)){
        const r=da/(da-db),k=3*outputCount++;
        output[k]=x+r*(xx-x);output[k+1]=y+r*(yy-y);output[k+2]=z+r*(zz-z);
      }
    }
    if(outputCount*3>output.length)throw Error('Convex clipping scratch bound exceeded');
    return outputCount;
  }
  evaluate(points:readonly V3[],areaM2:number,gradient:Float64Array,gram:Float64Array,terms?:TriangleGramTerm[]){
    if(points.length!==3||points.some(p=>p.length!==3||!p.every(Number.isFinite))||!(areaM2>0)||!Number.isFinite(areaM2))throw Error('Finite triangle, positive area required');
    if(gradient.length!==9||(gram.length!==0&&gram.length!==81))throw Error('Triangle output layout mismatch');
    gradient.fill(0);gram.fill(0);if(terms)terms.length=0;
    const distance=this.distances,planes=this.planes,stiffness=this.stiffness;
    let energyJ=0,activeAreaM2=0,pieces=0;
    for(let i=0;i<planes.length;i++){
      const {normal:n,offset:c}=planes[i]!;let minimum=Infinity;
      for(let j=0;j<3;j++){const p=points[j]!,d=n[0]*p[0]+n[1]*p[1]+n[2]*p[2]+c;distance[3*i+j]=d;minimum=Math.min(minimum,d);}
      if(minimum>=0)return {energyJ,activeAreaM2,pieces};
    }
    for(let i=0;i<planes.length;i++){
      const d0=distance[3*i]!,d1=distance[3*i+1]!,d2=distance[3*i+2]!,normal=planes[i]!.normal;
      let input=this.first,output=this.second;
      input[0]=1;input[1]=0;input[2]=0;input[3]=0;input[4]=1;input[5]=0;input[6]=0;input[7]=0;input[8]=1;
      let count=this.clip(input,3,-d0,-d1,-d2,output);[input,output]=[output,input];
      for(let j=0;j<planes.length&&count>=3;j++){
        if(j===i)continue;
        const a=d0-distance[3*j]!,b=d1-distance[3*j+1]!,c=d2-distance[3*j+2]!;
        if(Math.abs(a)<1e-15&&Math.abs(b)<1e-15&&Math.abs(c)<1e-15){if(j<i)count=0;continue;}
        count=this.clip(input,count,a,b,c,output);[input,output]=[output,input];
      }
      if(count<3)continue;
      const a0=input[0]!,a1=input[1]!,a2=input[2]!;
      for(let k=1;k+1<count;k++){
        const b=3*k,c=3*(k+1),b0=input[b]!,b1=input[b+1]!,b2=input[b+2]!,c0=input[c]!,c1=input[c+1]!,c2=input[c+2]!;
        const fraction=Math.abs((b1-a1)*(c2-a2)-(b2-a2)*(c1-a1)),area=areaM2*fraction;
        if(!(area>1e-30))continue;
        const pa=-(d0*a0+d1*a1+d2*a2),pb=-(d0*b0+d1*b1+d2*b2),pc=-(d0*c0+d1*c1+d2*c2);
        const sumP=0+pa+pb+pc,sumP2=0+pa*pa+pb*pb+pc*pc;
        const integratedP2=area*(sumP*sumP+sumP2)/12;
        energyJ+=.5*stiffness*integratedP2;activeAreaM2+=area;pieces++;
        for(let row=0;row<3;row++){
          const ar=input[row]!,br=input[b+row]!,cr=input[c+row]!,sumRow=ar+br+cr;
          const integratedPN=area*(sumP*sumRow+(0+pa*ar+pb*br+pc*cr))/12;
          for(let axis=0;axis<3;axis++)gradient[3*row+axis]!-=stiffness*integratedPN*normal[axis]!;
          if(gram.length)for(let col=0;col<3;col++){
            const ac=input[col]!,bc=input[b+col]!,cc=input[c+col]!;
            const integratedNN=area*(sumRow*(ac+bc+cc)+(0+ar*ac+br*bc+cr*cc))/12;
            for(let r=0;r<3;r++)for(let s=0;s<3;s++)gram[9*(3*row+r)+3*col+s]!+=stiffness*integratedNN*normal[r]!*normal[s]!;
          }
        }
        if(terms)for(let vertex=0;vertex<3;vertex++){
          const bary:V3=[0,0,0];
          for(let j=0;j<3;j++)for(let corner=0;corner<3;corner++)bary[j]!+=input[(corner===0?0:corner===1?b:c)+j]!*(corner===vertex?2/3:1/6);
          terms.push({bary,normal:[...normal],stiffness:stiffness*area/3});
        }
      }
    }
    return {energyJ,activeAreaM2,pieces};
  }
}
