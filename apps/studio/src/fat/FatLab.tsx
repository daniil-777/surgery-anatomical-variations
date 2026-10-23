import { VideoRecorderButton } from "../VideoRecorderPanel";
import { DisplaySettings, SceneResizeHandle } from "../DisplaySettings";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, ArrowDownToLine, Camera, Focus, Pause, Play, Shuffle } from "lucide-react";
import { publicUrl, reportReady } from "../api";
import { generateFatGeometry, FAT_GENERATOR_VERSION, FAT_PRESET_DIMENSIONS, type FatPreset } from "./generator";
import { fatDataTexture, disposeFatMaps, FAT_MATERIAL_VERSION, FAT_HEIGHT_AMPLITUDE_MM, type FatMaps, type FatSurfaceStudy } from "./material";
import { FAT_TEXTURE_TILE_MM, FAT_TEXTURE_VERSION } from "./texture";
import { FatReferenceViewport } from "./FatReferenceViewport";
import { FatViewport, type FatViewportHandle, type FatLighting } from "./FatViewport";
import { DEFAULT_FAT_PROTOCOL, FAT_MATERIAL_PRESETS, runFatCompression, type FatCompressionResult } from "./physics";
import { DEFAULT_FAT_CREEP_PROTOCOL, runFatCreep, fatCreepStressCapacityPa } from "./mechanicsExperiments";
import { FAT_OPTICS } from "./optics";
import "./fatLab.css";

interface Reference { id: string; title: string; url: string; image?: string; license: string; kind: string; note: string }
const nextSeed = () => crypto.getRandomValues(new Uint32Array(1))[0]!;
function download(blob: Blob, name: string) { const url=URL.createObjectURL(blob); const a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000); }
function Range({label,value,min,max,step=.01,unit="",onChange}: {label:string;value:number;min:number;max:number;step?:number;unit?:string;onChange:(value:number)=>void}) {
  return <label className="fat-range"><span>{label}<output>{value.toLocaleString("en",{maximumFractionDigits:2})}{unit}</output></span><input aria-label={label} type="range" min={min} max={max} step={step} value={value} onChange={e=>onChange(Number(e.target.value))}/></label>;
}
function MechanicsChart({run,index}: {run:Pick<FatCompressionResult,"frames"|"diagnostics">;index:number}) {
  const max=Math.max(...run.frames.map(f=>f.stressPa),1),min=Math.min(...run.frames.map(f=>f.stressPa),0),duration=run.frames.at(-1)!.timeSec;
  const x=(v:number)=>36+v/duration*316,y=(v:number)=>122-(v-min)/(max-min)*100;
  const frame=run.frames[index]!;
  return <div className="fat-chart"><div><span>Nominal stress</span><strong>{(frame.stressPa/1000).toFixed(2)} kPa</strong></div><svg viewBox="0 0 370 150" role="img" aria-label="Predicted compression stress over time, including signed release reaction">
    <line x1="36" x2="352" y1={y(0)} y2={y(0)} stroke="#53615e"/>
    <polyline points={run.frames.map(f=>`${x(f.timeSec)},${y(f.stressPa)}`).join(" ")} fill="none" stroke="#ecc887" strokeWidth="2"/>
    <polyline points={run.frames.map(f=>`${x(f.timeSec)},${122-f.strain/.35*100}`).join(" ")} fill="none" stroke="#82c4bf" strokeWidth="1.5"/>
    <line x1={x(frame.timeSec)} x2={x(frame.timeSec)} y1="18" y2="125" stroke="#c3d9cc" strokeDasharray="3 4"/>
    <text x="3" y="23">{(max/1000).toFixed(1)}</text><text x="3" y="123">{(min/1000).toFixed(1)}</text><text x="36" y="145">0 s</text><text x="315" y="145">{duration} s</text>
  </svg><small>Gold: nominal stress · teal: strain (0–35%)</small></div>;
}
export default function FatLab() {
  const [preset,setPreset]=useState<FatPreset>("visceral"),[shapeSeed,setShapeSeed]=useState(42),[textureSeed,setTextureSeed]=useState(731);
  const [study,setStudy]=useState<FatSurfaceStudy>("tissue"),[lighting,setLighting]=useState<FatLighting>("studio");
  const [thicknessMm,setThicknessMm]=useState(4),[drapeMm,setDrapeMm]=useState(32),[scattering,setScattering]=useState<number>(FAT_OPTICS.strength);
  const [shadows,setShadows]=useState(false),[lightOrbit,setLightOrbit]=useState(false);
  const [vessels,setVessels]=useState(.55),[septa,setSepta]=useState(1),[lobuleScale,setLobuleScale]=useState(1);
  const [resolution,setResolution]=useState(1024),[lobulation,setLobulation]=useState(.9),[wetness,setWetness]=useState(.48),[scale,setScale]=useState(1);
  const [textureValid,setTextureValid]=useState(false);
  const [maps,setMaps]=useState<FatMaps|null>(null),[baking,setBaking]=useState("Preparing texture fields…"),[error,setError]=useState("");
  const [showReference,setShowReference]=useState(false);
  const [rotate,setRotate]=useState(false),[tab,setTab]=useState<"specimen"|"mechanics"|"references">("specimen"),[references,setReferences]=useState<Reference[]>([]);
  const [experiment,setExperiment]=useState<"relaxation"|"creep"|"stress-cyclic">("relaxation"),[loadFraction,setLoadFraction]=useState(.3);
  const [compression,setCompression]=useState(25),[rampSec,setRampSec]=useState(1),[holdSec,setHoldSec]=useState(12),[shearKpa,setShearKpa]=useState(8);
  const [frame,setFrame]=useState(0),[playing,setPlaying]=useState(false),[exporting,setExporting]=useState(false);
  const viewport=useRef<FatViewportHandle>(null), mapsRef=useRef<FatMaps|null>(null);
  const specimen=useMemo(()=>generateFatGeometry({preset,shapeSeed,detail:128,lobulation,...(preset==="omental"?{thicknessMm:thicknessMm*scale,drapeMm:drapeMm*scale}:{}),densityKgM3:950,dimensionsMm:FAT_PRESET_DIMENSIONS[preset].map(x=>x*scale) as [number,number,number]}),[preset,shapeSeed,lobulation,scale,thicknessMm,drapeMm]);
  // The bench is an ideal 40×20×40 mm coupon. Its force is not inferred from the irregular display mesh.
  const material=useMemo(()=>({...FAT_MATERIAL_PRESETS[preset==="subcutaneous"?1:0]!.parameters,shearModulusPa:shearKpa*1000}),[preset,shearKpa]);
  const loadCapacity=fatCreepStressCapacityPa(material);
  const targetStressPa=loadCapacity*loadFraction;
  const run=useMemo(()=>experiment==="relaxation"?runFatCompression(material, {...DEFAULT_FAT_PROTOCOL,compression:compression/100,rampSec,holdSec}):runFatCreep(material,experiment==="creep"?{...DEFAULT_FAT_CREEP_PROTOCOL,targetStressPa,rampSec,holdSec,releaseSec:rampSec,recoverySec:30}:{kind:"stress-cyclic",targetStressPa,periodSec:Math.max(2,rampSec*4),cycles:4,stepSec:.02}),[material,experiment,targetStressPa,compression,rampSec,holdSec]);
  const current=run.frames[Math.min(frame,run.frames.length-1)]!;
  const deformation=useMemo(()=>tab==="mechanics"?{x:current.lateralStretch,y:current.stretch,z:current.lateralStretch}:{x:1,y:1,z:1},[tab,current]);
  useEffect(()=>{setFrame(0);setPlaying(false);},[run]);
  useEffect(()=>{
    const controller=new AbortController();
    void fetch(publicUrl("fat-lab/references.json"),{signal:controller.signal}).then(async r=>{if(!r.ok)throw new Error("Reference catalog unavailable");setReferences(await r.json() as Reference[]);}).catch(e=>{if(!controller.signal.aborted)setError(String(e));});
    return ()=>controller.abort();
  },[]);
  useEffect(()=>{
    setTextureValid(false);setBaking(`Baking ${resolution} × ${resolution} color…`);setError("");
    const worker=new Worker(new URL("./texture.worker.ts",import.meta.url),{type:"module"});
    const pending: Partial<FatMaps>={resolution}; let transferred=false;
    const clearPending=()=>{ pending.color?.dispose();pending.height?.dispose();pending.roughness?.dispose();delete pending.color;delete pending.height;delete pending.roughness; };
    worker.onmessage=(event:MessageEvent<{map?:"color"|"height"|"roughness";data?:Uint8Array;resolution?:number;done?:boolean;error?:string}>)=>{
      const message=event.data;
      if(message.error){setError(message.error+" The previous texture remains visible; exports require a successful bake.");setBaking("");worker.terminate();clearPending();return;}
      if(message.map&&message.data){pending[message.map]=fatDataTexture(message.data,resolution,message.map==="color");setBaking(message.map==="color"?"Baking relief…":message.map==="height"?"Baking roughness…":"Uploading texture maps…");}
      if(message.done&&pending.color&&pending.height&&pending.roughness){const next=pending as FatMaps;const old=mapsRef.current;mapsRef.current=next;setMaps(next);transferred=true;setTextureValid(true);setBaking("");reportReady("fat");setTimeout(()=>disposeFatMaps(old),0);worker.terminate();}
    };
    worker.onerror=event=>{worker.terminate();clearPending();setError((event.message||"Texture worker failed")+" The previous texture remains visible; exports require a successful bake.");setBaking("");};
    worker.postMessage({config:{preset,textureSeed,vascularity:vessels,septaStrength:septa,lobuleScale},resolution});
    return ()=>{worker.terminate();if(!transferred)clearPending();};
  },[preset,textureSeed,resolution,vessels,septa,lobuleScale]);
  useEffect(()=>()=>{disposeFatMaps(mapsRef.current);mapsRef.current=null;},[]);
  useEffect(()=>{
    if(!playing)return;const start=performance.now(),offset=current.timeSec;let animation=0;
    const tick=(now:number)=>{const t=offset+(now-start)/1000;const index=run.frames.findIndex(f=>f.timeSec>=t);if(index<0){setFrame(run.frames.length-1);setPlaying(false);}else{setFrame(index);animation=requestAnimationFrame(tick);}};
    animation=requestAnimationFrame(tick);return()=>cancelAnimationFrame(animation);
    // Playback captures the start frame; each frame must not restart the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[playing,run]);
  const recipe=()=>({schema:"viscera-fat-recipe-1",synthetic:true,generatorVersion:FAT_GENERATOR_VERSION,textureVersion:FAT_TEXTURE_VERSION,display:{study,lighting,shadows,lightOrbit},detail:128,densityKgM3:950,preset,shapeSeed,textureSeed,lobulation,scale,wetness,thicknessMm,drapeMm,optics:{...FAT_OPTICS,strength:scattering},textureConfig:{preset,textureSeed,wetness:.6,lobuleScale,septaStrength:septa,vascularity:vessels,colorVariation:1,normalStrength:1},textureResolution:maps?.resolution??0,requestedTextureResolution:resolution,textureMapping:{kind:"rest-space-triplanar",tileMm:FAT_TEXTURE_TILE_MM,shaderVersion:FAT_MATERIAL_VERSION,bumpAmplitudeMm:FAT_HEIGHT_AMPLITUDE_MM,ior:1.46,clearcoat:wetness},geometry:specimen.stats,mechanics:run,provenance:"Original procedural appearance. Literature-inspired uncalibrated material; no patient reconstruction.",references});
  const saveMap=(map:"color"|"height"|"roughness")=>{
    if(!maps||!textureValid||baking)return;
    const canvas=document.createElement("canvas");canvas.width=canvas.height=maps.resolution;
    const context=canvas.getContext("2d")!;const bytes=new Uint8ClampedArray(maps[map].image.data as Uint8Array);
    context.putImageData(new ImageData(bytes,maps.resolution,maps.resolution),0,0);
    canvas.toBlob(blob=>{if(blob)download(blob,`fat-${textureSeed}-${map}-${maps.resolution}.png`);else setError("PNG encoding failed.");},"image/png");
  };
  const sample=(kind:"shape"|"texture"|"both")=>{setPlaying(false);setFrame(0);if(kind!=="texture")setShapeSeed(nextSeed());if(kind!=="shape")setTextureSeed(nextSeed());};
  return <div className="fat-lab">
    <header className="fat-header"><a className="fat-brand" href="?mode=atlas"><Activity size={22}/><span>VISCERA <small>ADIPOSE LAB</small></span></a><nav aria-label="Anatomy workspace"><a href="?mode=atlas">Organ studio</a><a href="?mode=scene&fat=1">Fat around organs</a><a href="?mode=fat" aria-current="page">Fat lab</a></nav><DisplaySettings /><VideoRecorderButton /><span className="fat-badge">EXPERIMENTAL · V4</span></header>
    <main className="fat-stage"><SceneResizeHandle /><div className="fat-heading"><span className="fat-eyebrow">TISSUE STUDIES / 01</span><h1>{showReference?"Omentum, in context.":"Adipose, in detail."}</h1><p>{showReference?"Human Reference Atlas · original reference shape · neutral material":"Connected lobules. Fine septa. A wet tissue surface."}</p></div>
      {showReference?<FatReferenceViewport onError={setError}/>:<FatViewport ref={viewport} study={study} lighting={lighting} specimen={specimen} maps={maps} wetness={wetness} scattering={scattering} shadows={shadows} lightOrbit={lightOrbit} rotate={rotate} deformation={deformation} onError={setError}/>}
      {!showReference&&<div className="fat-stage-tools"><button onClick={()=>viewport.current?.fit()} aria-label="Fit fat specimen"><Focus size={17}/></button><button onClick={()=>setRotate(v=>!v)} aria-label="Rotate fat specimen" aria-pressed={rotate}>{rotate?<Pause size={17}/>:<Play size={17}/>}</button><button onClick={()=>{const url=viewport.current?.capture();if(url){const a=document.createElement("a");a.href=url;a.download=`fat-${shapeSeed}-4k.png`;a.click();}}} aria-label="Save 4K image"><Camera size={17}/></button></div>}
      <div className="fat-caption"><span>{showReference?"Drag to inspect original atlas geometry":"Drag to orbit · scroll to inspect · scale bar 50 mm"}</span><span>{showReference?"CC BY 4.0 · HRA female omentum":baking||`${maps?.resolution??0}² maps · ${(specimen.stats.triangleCount/1000).toFixed(1)}k triangles`}</span></div>
      {baking&&<div className="fat-baking" role="status"><i/>{baking}</div>}
      {error&&<div className="fat-error" role="alert">{error}<button onClick={()=>setError("")} aria-label="Dismiss error">×</button></div>}
    </main>
    <aside className="fat-panel"><div className="fat-tabs" role="tablist" aria-label="Fat lab panels">{(["specimen","mechanics","references"] as const).map(t=><button key={t} role="tab" aria-selected={tab===t} aria-controls={`fat-panel-${t}`} id={`fat-tab-${t}`} onClick={()=>{setPlaying(false);setShowReference(false);setTab(t);}}>{t[0]!.toUpperCase()+t.slice(1)}</button>)}</div>
      <div role="tabpanel" id={`fat-panel-${tab}`} aria-labelledby={`fat-tab-${tab}`}>
      {tab==="specimen"?<>
        <a className="fat-context-card" href="?mode=scene&fat=1"><span>ANATOMICAL CONTEXT</span><strong>Fat around organs ↗</strong><small>Inspect the omental apron and kidney fat from every side, under a camera-mounted light.</small></a>
        <div className="fat-section-title"><span>01</span> FORM & DEPOT</div><h2>A new tissue specimen</h2><p className="fat-copy">Sample the outer form and surface independently. Every seed is reproducible.</p>
        <label className="fat-field">Fat depot<select aria-label="Fat depot" value={preset} onChange={e=>{const p=e.target.value as FatPreset;setPreset(p);setShearKpa(p==="subcutaneous"?12:8);}}><option value="omental">Omental apron</option><option value="visceral">Visceral pad</option><option value="subcutaneous">Subcutaneous tissue</option></select></label>
        <div className="fat-seeds"><label>Shape seed<input aria-label="Shape seed" type="number" min="0" max="4294967295" value={shapeSeed} onChange={e=>{const v=Number(e.target.value);if(Number.isInteger(v)&&v>=0&&v<=4294967295)setShapeSeed(v);}}/></label><label>Texture seed<input aria-label="Texture seed" type="number" min="0" max="4294967295" value={textureSeed} onChange={e=>{const v=Number(e.target.value);if(Number.isInteger(v)&&v>=0&&v<=4294967295)setTextureSeed(v);}}/></label></div>
        <button className="fat-primary" onClick={()=>sample("both")}><Shuffle size={16}/>Sample new specimen</button><div className="fat-button-pair"><button onClick={()=>sample("shape")}>Shape only</button><button onClick={()=>sample("texture")}>Texture only</button></div>
        <Range label="Lobulation" value={lobulation} min={.2} max={1.5} onChange={setLobulation}/><Range label="Specimen scale" value={scale} min={.5} max={1.5} step={.05} unit="×" onChange={setScale}/>
        {preset==="omental"&&<><Range label="Sheet thickness" value={thicknessMm} min={.5} max={12} step={.5} unit=" mm" onChange={setThicknessMm}/><Range label="Fold depth" value={drapeMm} min={0} max={80} step={2} unit=" mm" onChange={setDrapeMm}/><p className="fat-copy">Fold depth and local tissue thickness vary independently. Smooth joined surfaces preserve a closed sheet.</p></>}
        <div className="fat-section-title"><span>02</span> SURFACE & RESOLUTION</div>
        <label className="fat-field">Surface study<select aria-label="Surface study" value={study} onChange={e=>setStudy(e.target.value as FatSurfaceStudy)}><option value="tissue">Lit tissue</option><option value="color">Base color · unlit</option><option value="relief">Relief · neutral clay</option><option value="geometry">Geometry · neutral clay</option></select></label>
        <label className="fat-field">Illumination<select aria-label="Illumination" value={lighting} onChange={e=>{setLighting(e.target.value as FatLighting);setLightOrbit(false);}}><option value="studio">Soft studio</option><option value="surgical">Camera light</option><option value="grazing">Grazing side light</option><option value="backlight">Thin tissue backlight</option><option value="dark">Lights off · diagnostic</option></select></label><Range label="Surface wet coat" value={wetness} min={0} max={1} onChange={setWetness}/>
        <label className="fat-field"><span><input type="checkbox" aria-label="Moving studio light" checked={lightOrbit} disabled={lighting!=="studio"&&lighting!=="grazing"} onChange={e=>setLightOrbit(e.target.checked)}/> Moving studio light</span></label><label className="fat-field"><span><input type="checkbox" aria-label="Surface self shadows" checked={shadows} onChange={e=>setShadows(e.target.checked)}/> Surface self shadows</span></label><Range label="Diffuse scattering" value={scattering} min={0} max={1} onChange={setScattering}/><p className="fat-copy">Approximate light diffusion uses a geometry thickness proxy. Thin folds respond to backlight; the model is not optically calibrated.</p>
        <Range label="Surface lobule scale" value={lobuleScale} min={.4} max={2.5} step={.1} unit="×" onChange={setLobuleScale}/><Range label="Connective septa" value={septa} min={0} max={2} step={.1} onChange={setSepta}/><Range label="Vessel visibility" value={vessels} min={0} max={2} step={.05} onChange={setVessels}/>
        <label className="fat-field">Texture resolution<select aria-label="Texture resolution" value={resolution} onChange={e=>setResolution(Number(e.target.value))}><option value={512}>512 · quick study</option><option value={1024}>1024 · interactive</option><option value={2048}>2048 · fine</option><option value={4096}>4096 · 4K</option></select></label><p className="fat-copy">Native generated color, relief and roughness maps. 4K bakes in a worker; three RGBA maps use 192 MiB before GPU mipmaps.</p>
        <dl className="fat-stats"><div><dt>Dimensions</dt><dd>{specimen.stats.dimensionsMm.map(v=>v.toFixed(0)).join(" × ")} mm</dd></div><div><dt>Closed mesh volume</dt><dd>{(specimen.stats.volumeMm3/1000).toFixed(1)} cm³</dd></div><div><dt>Mass at 950 kg/m³</dt><dd>{specimen.stats.massGrams.toFixed(1)} g</dd></div></dl>
        <div className="fat-section-title"><span>03</span> TAKE IT WITH YOU</div><div className="fat-map-buttons">{(["color","height","roughness"] as const).map(map=><button key={map} disabled={!maps||!textureValid||!!baking} onClick={()=>saveMap(map)}>{map} PNG</button>)}</div>
        <div className="fat-button-pair"><button disabled={!textureValid||!!baking||exporting} onClick={()=>download(new Blob([JSON.stringify(recipe(),null,2)],{type:"application/json"}),`fat-${shapeSeed}-recipe.json`)}><ArrowDownToLine size={14}/>Recipe JSON</button><button disabled={exporting} onClick={async()=>{setExporting(true);try{const buffer=await viewport.current!.exportGeometry();download(new Blob([buffer],{type:"model/gltf-binary"}),`fat-${shapeSeed}-geometry.glb`);}catch(e){setError(String(e));}finally{setExporting(false);}}}>Geometry GLB</button></div><p className="fat-copy">GLB exports rest geometry in metres. The lab’s triplanar material travels as separate maps and a recipe.</p>
      </>:tab==="mechanics"?<>
        <div className="fat-section-title"><span>01</span> COMPRESSION BENCH</div><h2>Press. Hold. Release.</h2><p className="fat-copy">A homogeneous 40 × 20 × 40 mm coupon predicts stress relaxation, load-controlled creep and recovery. The specimen previews the computed strain uniformly; local contact and sliding are not solved.</p>
        <label className="fat-field">Experiment<select aria-label="Experiment" value={experiment} onChange={e=>setExperiment(e.target.value as typeof experiment)}><option value="relaxation">Displacement · stress relaxation</option><option value="creep">Load · creep and recovery</option><option value="stress-cyclic">Load · repeated cycles</option></select></label>
        {experiment==="relaxation"?<Range label="Compression" value={compression} min={0} max={35} step={1} unit="%" onChange={setCompression}/>:<><Range label="Nominal load" value={targetStressPa/1000} min={0} max={loadCapacity*.9/1000} step={.01} unit=" kPa" onChange={v=>setLoadFraction(Math.min(.9,v*1000/loadCapacity))}/><p className="fat-copy">Load is a fraction of this material’s supported compression range and changes with modulus. Strain follows the relaxation history.</p></>}<Range label="Instantaneous shear modulus" value={shearKpa} min={1} max={30} step={.5} unit=" kPa" onChange={setShearKpa}/><Range label="Loading time" value={rampSec} min={.1} max={5} step={.1} unit=" s" onChange={setRampSec}/><Range label="Hold duration" value={holdSec} min={1} max={30} step={1} unit=" s" onChange={setHoldSec}/>
        <button className="fat-primary" onClick={()=>{if(frame>=run.frames.length-1)setFrame(0);setPlaying(v=>!v);}}>{playing?<Pause size={16}/>:<Play size={16}/>} {playing?"Pause experiment":"Play experiment"}</button>
        <MechanicsChart run={run} index={Math.min(frame,run.frames.length-1)}/><label className="fat-range"><span>Experiment time<output>{current.timeSec.toFixed(2)} s · {current.phase}</output></span><input aria-label="Experiment time" type="range" min={0} max={run.frames.length-1} value={frame} onChange={e=>{setPlaying(false);setFrame(Number(e.target.value));}}/></label>
        <dl className="fat-stats"><div><dt>Compression strain</dt><dd>{(current.strain*100).toFixed(2)}%</dd></div><div><dt>Coupon reaction</dt><dd>{current.forceN.toFixed(3)} N</dd></div><div><dt>Volume ratio J</dt><dd>{current.volumeRatio.toFixed(4)}</dd></div><div><dt>End/start hold stress</dt><dd>{run.diagnostics.holdRelaxationRatio===null?"—":(run.diagnostics.holdRelaxationRatio*100).toFixed(1)+"%"}</dd></div>{"holdCreepRatio" in run.diagnostics&&<><div><dt>End/start hold strain</dt><dd>{run.diagnostics.holdCreepRatio===null?"—":run.diagnostics.holdCreepRatio.toFixed(3)+"×"}</dd></div><div><dt>Load residual</dt><dd>{run.diagnostics.maximumStressResidualPa.toExponential(1)} Pa</dd></div></>}</dl>
        <p className="fat-note">Literature-inspired, uncalibrated. Nearly incompressible neo-Hookean elasticity with two relaxation times (1 s, 30 s). No friction, damage, cutting, fluid flow or patient calibration. Under displacement control, a negative release force implies tensile constraint. Under load control, zero-load recovery retains material history.</p>
        <button className="fat-secondary" onClick={()=>download(new Blob(["time_s,strain,nominal_stress_Pa,true_stress_Pa,force_N,volume_ratio\n"+run.frames.map(f=>[f.timeSec,f.strain,f.stressPa,f.cauchyStressPa,f.forceN,f.volumeRatio].join(",")).join("\n")],{type:"text/csv"}),`fat-${experiment}.csv`)}>Export experiment CSV</button>
      </>:<>
        <div className="fat-section-title"><span>01</span> SURGICAL REFERENCE DESK</div><h2>Compare with real tissue</h2><p className="fat-copy">Clinical images show lighting, fluid and blood as well as tissue. Compare connected lobules, pale septa, membranes and vessel paths; these are not calibrated color targets.</p>
        <button className="fat-primary" onClick={()=>setShowReference(value=>!value)}>{showReference?"Return to generated tissue":"Inspect open 3D omentum"}</button>
        {references.map(reference=><article className="fat-reference" key={reference.id}>{reference.image&&<a href={publicUrl(reference.image)} target="_blank" rel="noreferrer"><img src={publicUrl(reference.image)} alt={reference.title} loading="lazy"/></a>}<a href={reference.url} target="_blank" rel="noreferrer">{reference.title} ↗</a><p>{reference.note}</p><small>{reference.license}</small></article>)}
        <p className="fat-note">The generator uses original procedural fields. Surgical images are reference material, not a trained or reconstructed tissue surface.</p>
      </>}
      </div>
    </aside><footer className="fat-footer">WHITE ADIPOSE TISSUE <span>Procedural appearance · research mechanics · no anatomical or clinical validation</span></footer>
  </div>;
}
