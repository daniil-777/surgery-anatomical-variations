import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { BrainCircuit, Play, Square, Download, Plug } from "lucide-react";
import type { WholeSceneViewportHandle } from "./WholeSceneViewport";
import { VISUAL_SERVICE_URL } from "./visualPolicy";
import { initialVisualTask, runVisualTask } from "./visualTask";

export function VisualTaskLab({viewport,disabled,prepare,prepareGrasp,onActive,cancelToken}:{
  viewport:RefObject<WholeSceneViewportHandle|null>; disabled:boolean; prepare:()=>void;
  prepareGrasp:(signal:AbortSignal)=>Promise<void>; onActive:(active:boolean)=>void; cancelToken:number;
}) {
  const [state,setState]=useState(initialVisualTask),[service,setService]=useState<{ready:boolean;modelId:string;message:string}|null>(null);
  const [instruction,setInstruction]=useState("Look at the liver, grasp gently, and release."),[connecting,setConnecting]=useState(false);
  const controller=useRef<AbortController|null>(null),[active,setActive]=useState(false),alive=useRef(true);
  const stop=()=>{controller.current?.abort();viewport.current?.stopAutomaticGrasp();viewport.current?.stopCameraPath();};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();};},[]);
  useEffect(()=>{controller.current?.abort();},[cancelToken]);
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.code==="Escape"&&controller.current){event.preventDefault();stop();}};window.addEventListener("keydown",escape);return()=>window.removeEventListener("keydown",escape);});
  useEffect(()=>{(window as any).__visceraVisualTaskSnapshot=()=>({state,service,active});return()=>{delete (window as any).__visceraVisualTaskSnapshot;};},[state,service,active]);
  async function connect(){
    setConnecting(true);
    setService({ready:false,modelId:"",message:"Connecting to this Mac. Allow the browser's Apps on this device or local network prompt if shown."});
    try{
      const response=await fetch(`${VISUAL_SERVICE_URL}/health`,{signal:AbortSignal.timeout(location.protocol==="https:"?30000:5000)}); if(!response.ok)throw new Error("unavailable");
      const result=await response.json(); if(result.schema!=="viscera.visual-skills/1"||typeof result.modelId!=="string")throw new Error("incompatible");
      if(alive.current)setService({ready:result.ready===true,modelId:result.modelId,message:result.ready?"Local trained policy connected.":"The local policy has not passed its evaluation checks."});
    }catch{if(alive.current)setService({ready:false,modelId:"",message:"Start the local visual-policy service on this Mac. In the browser's site settings, allow Apps on this device or local network access, then connect again."});}
    finally{if(alive.current)setConnecting(false);}
  }
  async function start(){
    if(controller.current||disabled||!service?.ready||!viewport.current)return;
    const local=new AbortController();controller.current=local;setActive(true);onActive(true);setState(initialVisualTask());
    if(window.matchMedia("(max-width: 760px)").matches)document.querySelector(".whole-stage")?.scrollIntoView({block:"start",behavior:"smooth"});
    try{await runVisualTask({viewport:viewport.current,signal:local.signal,instruction,modelId:service.modelId,prepare,prepareGrasp,publish:value=>{if(alive.current)setState(value);}});}
    catch{/* The controller publishes the failure and releases the instrument. */}
    finally{controller.current=null;if(alive.current){setActive(false);onActive(false);}}
  }
  function download(){const url=URL.createObjectURL(new Blob([JSON.stringify({schema:"viscera.visual-task-study/1",instruction,...state,scene:viewport.current?.captureMetadata()})],{type:"application/json"}));const a=document.createElement("a");a.href=url;a.download="viscera-visual-task-study.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const stage=document.querySelector(".whole-stage");
  return <><section className="camera-visual-task" aria-label="Visual action policy">
    <span className="camera-default-badge"><BrainCircuit size={14}/> VISUAL POLICY 1 · LOCAL INFERENCE</span>
    <strong>See. Decide. Act.</strong>
    <p>A trained visual policy chooses the next skill from the surgical view and instrument state; the camera and tissue guards check every motion.</p>
    <label>Task instruction<select aria-label="Visual task instruction" value={instruction} disabled={active} onChange={event=>setInstruction(event.target.value)}>
      <option>Look at the liver, grasp gently, and release.</option>
      <option>Inspect the liver, gently grasp it, then let go.</option>
      <option>Approach the liver with the camera, grasp carefully, and release.</option>
    </select></label>
    <button disabled={active||connecting} onClick={()=>void connect()}><Plug size={14}/>{connecting?"Connecting…":"Connect local policy"}</button>
    <small role="status">{service?.message??"Inference runs on this Mac. Connect after starting the local service."}</small>
    <button className="camera-default-start" disabled={disabled||active||!service?.ready} onClick={()=>void start()}><Play size={16}/>Run visual liver task</button>
    {active&&<button className="camera-task-stop" onClick={stop}><Square size={14}/>Stop visual task & release</button>}
    {state.message&&<p role="status">{state.message}</p>}
    {state.decisions.length>0&&<><ol className="camera-visual-decisions">{state.decisions.map((decision,i)=><li key={i}><span>{decision.skill}</span><small>{decision.inferenceMs.toFixed(0)} ms inference</small></li>)}</ol>{!active&&<button onClick={download}><Download size={14}/>Export visual task study</button>}</>}
  </section>{active&&stage&&createPortal(<div className="camera-visual-live" role="region" aria-label="Live visual policy"><span><BrainCircuit size={14}/>Visual policy · {state.phase==="thinking"?"choosing a skill":state.phase}</span><button onClick={stop}><Square size={13}/>Stop & release</button></div>,stage)}</>;
}
