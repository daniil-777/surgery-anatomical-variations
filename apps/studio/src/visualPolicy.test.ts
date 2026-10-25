import { describe, it, expect } from "vitest";
import { assertSkillTransition, validateVisualDecision, visualState, visualSceneSignature } from "./visualPolicy";
const metadata = {camera:{position:[10,20,30],target:[0,0,0]},tools:{active:false,jawClosure:0,reactionN:0},physics:null,organs:[{id:"liver",geometrySignature:"a",materialSignature:"b",visible:true}]};
const decision = {requestId:"request-1",skill:"look",scores:[1,0,0,0,0],margin:1,modelId:"visual-policy-1",inferenceMs:123,accepted:true};
describe("visual skill boundary",()=>{
  it("rejects stale identities, nonfinite outputs, and mislabeled actions",()=>{
    expect(()=>validateVisualDecision(decision,"different")).toThrow();
    expect(()=>validateVisualDecision({...decision,scores:[NaN,0,0,0,0]},"request-1")).toThrow();
    expect(()=>validateVisualDecision({...decision,skill:"grasp"},"request-1")).toThrow();
  });
  it("abstains on ambiguous or explicitly rejected decisions",()=>{
    expect(()=>validateVisualDecision({...decision,scores:[.8,.6,0,0,0],margin:.2},"request-1")).toThrow();
    expect(()=>validateVisualDecision({...decision,accepted:false},"request-1")).toThrow();
    expect(validateVisualDecision(decision,"request-1").skill).toBe("look");
  });
  it("never turns an invalid model prediction into a scripted substitute",()=>{
    for(const [previous,next] of [["none","look"],["look","grasp"],["grasp","release"],["release","finish"]] as const)expect(()=>assertSkillTransition(previous,next)).not.toThrow();
    expect(()=>assertSkillTransition("none","grasp")).toThrow();
    expect(()=>assertSkillTransition("grasp","finish")).toThrow();
    expect(()=>assertSkillTransition("look","wait")).toThrow();
  });
  it("uses observed pose, instrument state, and action history without teacher labels",()=>{
    const state=visualState(metadata,"none");expect(state).toHaveLength(16);expect(state[10]).toBe(1);
    expect(visualState({...metadata,teacherLabel:"release",automaticGrasp:{phase:"complete"}},"none")).toEqual(state);
    expect(()=>visualState({...metadata,camera:{...metadata.camera,position:[NaN,0,0]}},"none")).toThrow();
  });
  it("invalidates a pending observation when anatomy, visibility, or camera changes",()=>{
    const original=visualSceneSignature(metadata);
    expect(visualSceneSignature({...metadata,camera:{...metadata.camera,position:[0,0,0]}})).not.toBe(original);
    expect(visualSceneSignature({...metadata,organs:[{...metadata.organs[0],visible:false}]})).not.toBe(original);
    expect(visualSceneSignature({...metadata,physics:{displacement_mm:.2}})).toBe(original);
  });
});
