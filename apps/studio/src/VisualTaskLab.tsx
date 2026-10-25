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
  const connection=useRef<AbortController|null>(null);
  const controller=useRef<AbortController|null>(null),[active,setActive]=useState(false),alive=useRef(true);
  const stop=()=>{controller.current?.abort();viewport.current?.stopAutomaticGrasp();viewport.current?.stopCameraPath();};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();connection.current?.abort();};},[]);
  useEffect(()=>{controller.current?.abort();connection.current?.abort();},[cancelToken]);
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.code==="Escape"&&controller.current){event.preventDefault();stop();}};window.addEventListener("keydown",escape);return()=>window.removeEventListener("keydown",escape);});
  useEffect(()=>{(window as any).__visceraVisualTaskSnapshot=()=>({state,service,active});return()=>{delete (window as any).__visceraVisualTaskSnapshot;};},[state,service,active]);
  async function connect(signal?:AbortSignal){
    if(connection.current)return null;
    const attempt=new AbortController();connection.current=attempt;
    setConnecting(true);
    setService({ready:false,modelId:"",message:"Connecting to this Mac. Allow the browser's Apps on this device or local network prompt if shown."});
    try{
      const combined=AbortSignal.any([attempt.signal,AbortSignal.timeout(location.protocol==="https:"?30000:5000),...(signal?[signal]:[])]);
      const response=await fetch(`${VISUAL_SERVICE_URL}/health`,{signal:combined,cache:"no-store"});
      if(!response.ok)throw new Error(`The local policy returned HTTP ${response.status}. Restart the local service, then retry.`);
      const result=await response.json();combined.throwIfAborted();
      if(result.schema!=="viscera.visual-skills/1"||typeof result.modelId!=="string"||!result.modelId.trim()||typeof result.ready!=="boolean")throw new Error("The local service returned an incompatible policy. Restart Visual Policy 1, then retry.");
      const verified={ready:result.ready,modelId:result.modelId,message:result.ready?"Local trained policy connected.":"The local policy has not passed its evaluation checks. No motion can start."};
      if(alive.current)setService(verified);
      return verified;
    }catch(error){
      if(alive.current){
        const cancelled=attempt.signal.aborted||signal?.aborted;
        const message=cancelled?"Connection cancelled. You can run the task again.":error instanceof TypeError||!(error instanceof Error)||error.name==="TimeoutError"
          ?"The local policy is not reachable at 127.0.0.1:8877. Start Visual Policy 1 on this Mac, then retry. If it is already running, allow Apps on this device or local network access in this site's browser settings."
          :error.message;
        setService({ready:false,modelId:"",message});
      }
      return null;
    }finally{if(connection.current===attempt)connection.current=null;if(alive.current)setConnecting(false);}
  }
  async function start(){
    if(controller.current||connection.current||disabled||!viewport.current)return;
    const target=viewport.current,local=new AbortController();controller.current=local;
    setActive(true);onActive(true);setState({...initialVisualTask(),phase:"connecting",message:"Checking the local policy before starting…"});
    if(window.matchMedia("(max-width: 760px)").matches)document.querySelector(".whole-stage")?.scrollIntoView({block:"start",behavior:"smooth"});
    try{
      // Read fresh health on every run; permission and an old connection are not readiness.
      const verified=await connect(local.signal);
      if(local.signal.aborted||viewport.current!==target){if(alive.current)setState({...initialVisualTask(),phase:"stopped",message:"Visual task cancelled before motion."});return;}
      if(!verified?.ready){if(alive.current)setState({...initialVisualTask(),phase:"blocked",message:"The local policy is unavailable. No camera or tool motion was started. Retry after reconnecting the service."});return;}
      await runVisualTask({viewport:target,signal:local.signal,instruction,modelId:verified.modelId,prepare,prepareGrasp,publish:value=>{if(alive.current)setState(value);}});
    }catch{/* The task controller publishes the failure and releases the instrument. */}
    finally{if(controller.current===local)controller.current=null;if(alive.current){setActive(false);onActive(false);}}
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
    <small role="status">{service?.message??"Run connects to the policy on this Mac before any camera or tool movement."}</small>
    <button className="camera-default-start" disabled={disabled||active||connecting} onClick={()=>void start()}><Play size={16}/>Run visual liver task</button>
    {active&&<button className="camera-task-stop" onClick={stop}><Square size={14}/>Stop visual task & release</button>}
    {state.message&&<p role="status">{state.message}</p>}
    {state.decisions.length>0&&<><ol className="camera-visual-decisions">{state.decisions.map((decision,i)=><li key={i}><span>{decision.skill}</span><small>{decision.inferenceMs.toFixed(0)} ms inference</small></li>)}</ol>{!active&&<button onClick={download}><Download size={14}/>Export visual task study</button>}</>}
  </section>{active&&stage&&createPortal(<div className="camera-visual-live" role="region" aria-label="Live visual policy"><span><BrainCircuit size={14}/>Visual policy · {state.phase==="thinking"?"choosing a skill":state.phase}</span><button onClick={stop}><Square size={13}/>Stop & release</button></div>,stage)}</>;
}
