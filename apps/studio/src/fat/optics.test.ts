import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { FAT_OPTICS, fatDiffuseLobe, fatOutgoingInterface } from "./optics";
import { createFatMaterial, fatDataTexture, updateFatOptics, updateFatAppearance, disposeFatMaps } from "./material";

function injectedFatShader(anatomical = true) {
  const maps={color:fatDataTexture(new Uint8Array(16),2,true),height:fatDataTexture(new Uint8Array(16),2),roughness:fatDataTexture(new Uint8Array(16),2),resolution:2};
  const material=createFatMaterial(maps,.48,undefined,"tissue",anatomical);
  const shader={vertexShader:THREE.ShaderLib.physical.vertexShader,fragmentShader:THREE.ShaderLib.physical.fragmentShader,uniforms:{}};
  try {
    material.onBeforeCompile(shader as Parameters<typeof material.onBeforeCompile>[0],{} as THREE.WebGLRenderer);
    return shader.fragmentShader.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  } finally { material.dispose(); disposeFatMaps(maps); }
}

function shaderFunction(source: string, name: string): string {
  const declaration=source.search(new RegExp(`\\b(?:vec[234]|float)\\s+${name}\\s*\\(`));
  expect(declaration, `${name} must be injected into the installed Three shader`).toBeGreaterThanOrEqual(0);
  const start=source.indexOf("{",declaration);
  let depth=1, end=start+1;
  for(;end<source.length && depth>0;end++) { if(source[end]==="{") depth++; else if(source[end]==="}") depth--; }
  expect(depth).toBe(0);
  return source.slice(start+1,end-1);
}

describe("authored adipose direct-light diffusion surrogate", () => {
  it("preserves Lambert's angular lobe budget across thickness and scattering sweeps", () => {
    // Independent midpoint quadrature over all incident directions: dΩ=2π dcosθ.
    for (const thickness of [0,.01,.5,2,5,15,100]) for (const amount of [0,.25,.5,1]) {
      const integral = [0,0,0], samples = 10000; let minimum=Infinity, maximum=-Infinity;
      for (let i=0;i<samples;i++) fatDiffuseLobe(-1+(i+.5)*2/samples,thickness,amount).forEach((v,c)=>{ minimum=Math.min(minimum,v); maximum=Math.max(maximum,v); integral[c]!+=v*4*Math.PI/samples; });
      expect(minimum).toBeGreaterThanOrEqual(0); expect(maximum).toBeLessThanOrEqual(1);
      for (const value of integral) expect(value).toBeCloseTo(Math.PI,6);
    }
  });
  it("restores Lambert exactly at zero strength and attenuates backlighting monotonically", () => {
    for (const cosine of [-1,-.5,0,.4,1]) expect(fatDiffuseLobe(cosine,3,0)).toEqual([Math.max(cosine,0),Math.max(cosine,0),Math.max(cosine,0)]);
    let previous = [1,1,1];
    for (const thickness of [0,.1,1,3,8,30,1000]) {
      const response = fatDiffuseLobe(-1,thickness);
      response.forEach((v,i)=>expect(v).toBeLessThanOrEqual(previous[i]!));
      expect(response[0]).toBeGreaterThanOrEqual(response[1]); expect(response[1]).toBeGreaterThanOrEqual(response[2]); previous=response;
    }
    expect(previous[0]).toBeLessThan(1e-100);
    expect(fatDiffuseLobe(-1,2)[1]).toBeCloseTo(FAT_OPTICS.strength*Math.exp(-2/2.4),12);
  });
  it("rejects invalid optical inputs without masking bad geometry", () => {
    for (const args of [[NaN,1,.5],[1,-1,.5],[2,1,.5],[1,Infinity,.5],[1,1,1.1]]) expect(()=>fatDiffuseLobe(...args as [number,number,number])).toThrow(RangeError);
  });
  it("keeps the opposite-light back lobe finite and nonzero after its outgoing interface", () => {
    // L=-V and N=V: the reflection half vector L+V is exactly zero. A thin
    // transmitter should still have a finite nonzero outgoing diffuse response.
    const thin=fatDiffuseLobe(-1,.5).map(value=>value*fatOutgoingInterface(1));
    const thick=fatDiffuseLobe(-1,40).map(value=>value*fatOutgoingInterface(1));
    expect(Math.min(...thin)).toBeGreaterThan(.3);
    expect(Math.max(...thick)).toBeLessThan(.0001);
    for(let i=0;i<=100;i++) for(const f0 of [0,.023,.04,.5,1]) {
      const response=fatOutgoingInterface(i/100,f0); expect(response).toBeGreaterThanOrEqual(0); expect(response).toBeLessThanOrEqual(1-f0);
    }
    expect(fatOutgoingInterface(0)).toBe(0);
    expect(()=>fatOutgoingInterface(NaN)).toThrow(RangeError);
  });
  it("integrates into installed Three physical lighting and updates without texture allocation", () => {
    const maps={color:fatDataTexture(new Uint8Array(16),2,true),height:fatDataTexture(new Uint8Array(16),2),roughness:fatDataTexture(new Uint8Array(16),2),resolution:2};
    const material=createFatMaterial(maps);
    const shader={vertexShader:THREE.ShaderLib.physical.vertexShader,fragmentShader:THREE.ShaderLib.physical.fragmentShader,uniforms:{}};
    material.onBeforeCompile(shader as Parameters<typeof material.onBeforeCompile>[0],{} as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain("directLight.color * fatDiffuseLobe");
    expect(shader.fragmentShader).toContain("saturate(dot(geometryNormal, geometryViewDir))");
    expect(shader.fragmentShader).toContain("BRDF_Lambert( material.diffuseContribution ) * fatExit");
    expect(shader.fragmentShader).toContain("reflectedLight.directSpecular += irradiance * specularBRDF");
    expect(shader.fragmentShader).not.toContain("#include <lights_physical_pars_fragment>");
    updateFatOptics(material,.8,.7);
    expect((shader.uniforms as Record<string,{value:number}>).uFatScatter!.value).toBe(.8);
    expect((shader.uniforms as Record<string,{value:number}>).uFatThicknessScale!.value).toBe(.7);
    expect(()=>updateFatOptics(material,-1)).toThrow();
    material.dispose();disposeFatMaps(maps);
  });
  it("keeps depot inspection controls live across recompilation without replacing maps", () => {
    const maps={color:fatDataTexture(new Uint8Array(16),2,true),height:fatDataTexture(new Uint8Array(16),2),roughness:fatDataTexture(new Uint8Array(16),2),resolution:2};
    const material=createFatMaterial(maps,.52,undefined,"tissue",true);
    const compile=()=>{const shader={vertexShader:THREE.ShaderLib.physical.vertexShader,fragmentShader:THREE.ShaderLib.physical.fragmentShader,uniforms:{} as Record<string,{value:unknown}>};material.onBeforeCompile(shader as Parameters<typeof material.onBeforeCompile>[0],{} as THREE.WebGLRenderer);return shader;};
    const first=compile();
    updateFatAppearance(material,0,"color");
    expect(material.clearcoat).toBe(0);expect(material.toneMapped).toBe(false);
    expect(first.uniforms.uFatStudy!.value).toBe(1);
    const second=compile();
    expect(second.uniforms.uFatStudy).toBe(first.uniforms.uFatStudy);
    expect(second.uniforms.uFatColor!.value).toBe(maps.color);
    expect(second.vertexShader).toContain("vFatRegion = fatRegion;");
    expect(second.fragmentShader).toContain("material.thickness = max(vFatThicknessMm");
    updateFatAppearance(material,.8,"geometry");expect(first.uniforms.uFatStudy!.value).toBe(3);expect(material.toneMapped).toBe(true);
    expect(()=>updateFatAppearance(material,NaN,"tissue")).toThrow(RangeError);expect(material.clearcoat).toBe(.8);
    material.dispose();disposeFatMaps(maps);
  });
  it("renders closed anatomical shells from the front while preserving the double-sided standalone material", () => {
    const maps={color:fatDataTexture(new Uint8Array(16),2,true),height:fatDataTexture(new Uint8Array(16),2),roughness:fatDataTexture(new Uint8Array(16),2),resolution:2};
    const standalone=createFatMaterial(maps), anatomical=createFatMaterial(maps,.48,undefined,"tissue",true);
    try {
      // FrontSide removes the redundant transmissive backface pass; it must not
      // achieve stability by switching off the membrane's transmission instead.
      expect(anatomical.side).toBe(THREE.FrontSide); expect(anatomical.transmission).toBeGreaterThan(0);
      expect(standalone.side).toBe(THREE.DoubleSide); expect(standalone.transmission).toBe(0);
      expect(anatomical.customProgramCacheKey()).not.toBe(standalone.customProgramCacheKey());
      for(const study of ["tissue","color","relief","geometry"] as const) {
        updateFatAppearance(anatomical,.6,study); updateFatAppearance(standalone,.6,study);
        expect(anatomical.side).toBe(THREE.FrontSide); expect(standalone.side).toBe(THREE.DoubleSide);
      }
    } finally { anatomical.dispose(); standalone.dispose(); disposeFatMaps(maps); }
  });
  it("evaluates custom bump derivatives before any per-fragment branch or early return", () => {
    const shader=injectedFatShader(), bump=shaderFunction(shader,"fatBump");
    const derivatives=[...bump.matchAll(/\bdFd[xy]\s*\(\s*(\w+)\s*\)/g)];
    expect(derivatives.map(match=>match[0].replace(/\s/g,""))).toEqual(expect.arrayContaining([
      "dFdx(p)","dFdy(p)","dFdx(vFatRest)","dFdy(vFatRest)",
    ]));
    const firstControl=bump.search(/\b(?:if|return|for|while|switch)\b|\?/);
    expect(firstControl).toBeGreaterThan(0);
    for(const derivative of derivatives) expect(derivative.index!,derivative[0]).toBeLessThan(firstControl);
    const planar=shaderFunction(shader,"fatPlanarGradient");
    for(const derivative of planar.matchAll(/\bdFd[xy]\s*\(/g)) expect(derivative.index!).toBeLessThan(planar.search(/\b(?:if|return)\b|\?/));
    // The caller's inspection-mode branch is uniform across a fragment quad.
    expect(shader).toMatch(/if\s*\(uFatStudy\s*==\s*0\s*\|\|\s*uFatStudy\s*==\s*2\)\s*normal\s*=\s*fatBump/);
  });
  it("guards custom normalization against zero, overflow and invalid interpolated normals", () => {
    const shader=injectedFatShader(), safe=shaderFunction(shader,"fatSafeNormal"), bump=shaderFunction(shader,"fatBump");
    // These are shader-source contracts, not a substitute for native GPU
    // qualification. Both bounds are needed: NaN and infinity must also select
    // the fallback instead of propagating through physical transmission.
    expect(safe).toMatch(/float\s+lengthSquared\s*=\s*dot\(n,\s*n\)/);
    expect(safe).toMatch(/return\s+lengthSquared\s*>\s*1e-12\s*&&\s*lengthSquared\s*<\s*1e20\s*\?\s*n\s*\*\s*inversesqrt\(lengthSquared\)\s*:\s*vec3\(0\.0,\s*0\.0,\s*1\.0\)/);
    for(const name of ["fatSample","fatGradient"]) {
      const body=shaderFunction(shader,name);
      expect(body).toContain("fatSafeNormal(n)"); expect(body).not.toMatch(/\bnormalize\s*\(/);
    }
    expect(bump).toMatch(/if\s*\(abs\(det\)\s*<\s*1e-10\)\s*return\s+n\s*;/);
    expect(bump).toMatch(/return\s+bumpedLengthSquared\s*>\s*1e-20\s*&&\s*bumpedLengthSquared\s*<\s*1e20\s*\?\s*bumped\s*\*\s*inversesqrt\(bumpedLengthSquared\)\s*:\s*n\s*;/);
    expect(bump).not.toMatch(/\bnormalize\s*\(/);
    expect(shader).not.toContain("vec3 normal = normalize( vNormal );");
    expect(shader).toMatch(/vec3\s+fatFaceNormal\s*=\s*cross\(dFdx\(vViewPosition\),\s*dFdy\(vViewPosition\)\)/);
    expect(shader.indexOf("vec3 fatFaceNormal")).toBeLessThan(shader.indexOf("vec3 normal = fatNormalLengthSquared"));
    expect(shader).toMatch(/vec3\s+normal\s*=\s*fatNormalLengthSquared\s*>\s*1e-12\s*&&\s*fatNormalLengthSquared\s*<\s*1e20\s*\?\s*vNormal\s*\*\s*inversesqrt\(fatNormalLengthSquared\)\s*:\s*fatSafeNormal\(fatFaceNormal\)\s*\*\s*faceDirection/);
  });
});
