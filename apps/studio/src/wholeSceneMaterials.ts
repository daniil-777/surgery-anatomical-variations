import * as THREE from "three";
import { validateReferenceColor, type ReferenceColor } from "./atlasMaterial";
import { referenceBaseColor, REFERENCE_ORGAN_IDS } from "./referenceColor";
import { sceneRandom, wholeSceneTissue, type WholeSceneCategory, type WholeSceneVariation } from "./wholeSceneModel";

export const WHOLE_SCENE_MATERIAL_VERSION = "organ-tissue-optics-2.1.0";
interface TissuePart { id: string; category: WholeSceneCategory; color: string }
interface TissueProfile {
  name: string; color: string; undertone: string; type: number;
  roughness: number; wetness: number; detailMm: number; pigment: number; structure: number; reliefMm: number;
}
const profiles: Record<string, TissueProfile> = {
  liver: { name: "hepatic capsule", color: "#713630", undertone: "#48251f", type: 0, roughness: .32, wetness: .08, detailMm: 2.4, pigment: .24, structure: .13, reliefMm: .014 },
  spleen: { name: "splenic capsule", color: "#643343", undertone: "#371c31", type: 0, roughness: .4, wetness: .21, detailMm: 2.2, pigment: .2, structure: .17, reliefMm: .018 },
  "left-kidney": { name: "renal capsule", color: "#98544a", undertone: "#632e31", type: 0, roughness: .35, wetness: .27, detailMm: 2.8, pigment: .18, structure: .13, reliefMm: .012 },
  "right-kidney": { name: "renal capsule", color: "#98544a", undertone: "#632e31", type: 0, roughness: .35, wetness: .27, detailMm: 2.8, pigment: .18, structure: .13, reliefMm: .012 },
  "left-lung": { name: "pleura / lobular parenchyma", color: "#a87582", undertone: "#644755", type: 1, roughness: .57, wetness: .09, detailMm: 5.2, pigment: .17, structure: .14, reliefMm: .025 },
  "right-lung": { name: "pleura / lobular parenchyma", color: "#a87582", undertone: "#644755", type: 1, roughness: .57, wetness: .09, detailMm: 5.2, pigment: .17, structure: .14, reliefMm: .025 },
  stomach: { name: "gastric serosa", color: "#bf8c81", undertone: "#875050", type: 2, roughness: .38, wetness: .2, detailMm: 5.5, pigment: .13, structure: .23, reliefMm: .024 },
  "small-intestine": { name: "intestinal serosa", color: "#bd9387", undertone: "#885854", type: 2, roughness: .4, wetness: .19, detailMm: 4.8, pigment: .12, structure: .22, reliefMm: .022 },
  colon: { name: "colonic serosa", color: "#ae8077", undertone: "#714947", type: 2, roughness: .43, wetness: .16, detailMm: 5.5, pigment: .16, structure: .25, reliefMm: .025 },
  duodenum: { name: "duodenal serosa", color: "#b68779", undertone: "#82504c", type: 2, roughness: .4, wetness: .19, detailMm: 4.5, pigment: .13, structure: .22, reliefMm: .022 },
  gallbladder: { name: "biliary serosa", color: "#738354", undertone: "#46523a", type: 2, roughness: .32, wetness: .27, detailMm: 4.2, pigment: .18, structure: .22, reliefMm: .018 },
  pancreas: { name: "pancreatic lobulation", color: "#bfa083", undertone: "#88705b", type: 3, roughness: .55, wetness: .08, detailMm: 3.5, pigment: .22, structure: .3, reliefMm: .052 },
  heart: { name: "epicardium / myocardial direction", color: "#914e4a", undertone: "#572a30", type: 4, roughness: .41, wetness: .22, detailMm: 3.2, pigment: .18, structure: .065, reliefMm: .009 },
  diaphragm: { name: "diaphragmatic fibers", color: "#9c6b61", undertone: "#614541", type: 4, roughness: .48, wetness: .08, detailMm: 2.7, pigment: .16, structure: .24, reliefMm: .025 },
  esophagus: { name: "longitudinal muscular wall", color: "#a37571", undertone: "#754a4a", type: 4, roughness: .44, wetness: .13, detailMm: 2.5, pigment: .12, structure: .2, reliefMm: .02 },
  trachea: { name: "airway cartilage", color: "#b7a692", undertone: "#8d7468", type: 5, roughness: .53, wetness: .08, detailMm: 2.8, pigment: .08, structure: .08, reliefMm: .012 },
  bronchi: { name: "bronchial cartilage", color: "#b5a08e", undertone: "#887064", type: 5, roughness: .5, wetness: .09, detailMm: 2.4, pigment: .1, structure: .1, reliefMm: .014 },
  aorta: { name: "arterial adventitia", color: "#ae7770", undertone: "#774345", type: 5, roughness: .4, wetness: .16, detailMm: 2, pigment: .12, structure: .14, reliefMm: .015 },
  "vena-cava": { name: "venous wall", color: "#6e768d", undertone: "#454b65", type: 5, roughness: .35, wetness: .2, detailMm: 2, pigment: .13, structure: .13, reliefMm: .014 },
  "portal-vein": { name: "portal venous wall", color: "#857289", undertone: "#4e475f", type: 5, roughness: .37, wetness: .19, detailMm: 2, pigment: .14, structure: .14, reliefMm: .014 },
  "hepatic-artery": { name: "arterial adventitia", color: "#b27a6d", undertone: "#80494a", type: 5, roughness: .39, wetness: .17, detailMm: 1.7, pigment: .13, structure: .14, reliefMm: .014 },
};
function profileFor(part: TissuePart): TissueProfile {
  const exact = profiles[part.id];
  if (exact) return exact;
  if (part.id === "mesentery") return { name: "mesenteric connective membrane / fat", color: "#b9a182", undertone: "#91765b", type: 3, roughness: .52, wetness: .09, detailMm: 4.2, pigment: .13, structure: .17, reliefMm: .027 };
  if (part.id.endsWith("-artery") || part.id === "celiac-trunk") return profiles.aorta!;
  if (part.id.endsWith("-vein")) return profiles["vena-cava"]!;
  if (part.category === "skeleton") return { name: "cortical bone", color: "#c6b496", undertone: "#92846d", type: 6, roughness: .66, wetness: .015, detailMm: 1.2, pigment: .1, structure: .08, reliefMm: .018 };
  if (part.id.includes("duct")) return { name: "biliary / pancreatic duct wall", color: "#afa777", undertone: "#78754f", type: 5, roughness: .42, wetness: .15, detailMm: 1.8, pigment: .11, structure: .1, reliefMm: .012 };
  if (part.id.includes("ureter")) return { name: "ureteral wall", color: "#b8a18a", undertone: "#896e65", type: 4, roughness: .43, wetness: .13, detailMm: 2.2, pigment: .1, structure: .15, reliefMm: .013 };
  return { name: "soft tissue serosa", color: part.id === "urinary-bladder" ? "#b49a83" : part.color, undertone: "#876960", type: 2, roughness: .44, wetness: .15, detailMm: 4, pigment: .14, structure: .18, reliefMm: .02 };
}

/** Authored sRGB baseline shared with the reference palette planner. No GPU state. */
export function wholeSceneBaselineColor(part: TissuePart): [number, number, number] {
  const hex = profileFor(part).color.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error("Invalid authored tissue colour");
  return [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255) as [number, number, number];
}

/** A periodic 1 MiB four-channel field: cloud pigment, lobular distance, cell
 * boundaries and fine tissue grain. Shared across organs, anchored in rest mm.
 * It is an authored optical texture, not a reconstruction of histology/vessels. */
export function createWholeSceneTissueVolume(): THREE.Data3DTexture {
  const size = 64, data = new Uint8Array(size ** 3 * 4);
  const wrap = (n: number, period: number) => ((n % period) + period) % period;
  const hash = (x: number, y: number, z: number, period: number) => sceneRandom(wrap(x, period) + wrap(y, period) * period + wrap(z, period) * period * period, 19);
  const noise = (x: number, y: number, z: number, period: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    let fx = x - ix, fy = y - iy, fz = z - iz;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    let sum = 0;
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
      sum += hash(ix + dx, iy + dy, iz + dz, period) * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    }
    return sum;
  };
  const cells: [number, number, number][] = [];
  for (let z = -1; z <= 4; z++) for (let y = -1; y <= 4; y++) for (let x = -1; x <= 4; x++) {
    const id = wrap(x, 4) + wrap(y, 4) * 4 + wrap(z, 4) * 16;
    cells.push([x + .16 + .68 * sceneRandom(id, 31), y + .16 + .68 * sceneRandom(id, 32), z + .16 + .68 * sceneRandom(id, 33)]);
  }
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = x / 16, py = y / 16, pz = z / 16;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    let first = 99, second = 99;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cell = cells[(iz + dz + 1) * 36 + (iy + dy + 1) * 6 + ix + dx + 1]!;
      const distance = (px - cell[0]) ** 2 + (py - cell[1]) ** 2 + (pz - cell[2]) ** 2;
      if (distance < first) { second = first; first = distance; } else if (distance < second) second = distance;
    }
    const index = ((z * size + y) * size + x) * 4;
    data[index] = Math.round(noise(x / 8, y / 8, z / 8, 8) * 255);
    data[index + 1] = Math.round(Math.min(1, Math.sqrt(first)) * 255);
    data[index + 2] = Math.round(Math.min(1, (Math.sqrt(second) - Math.sqrt(first)) * 2.5) * 255);
    data[index + 3] = Math.round(noise(x / 4, y / 4, z / 4, 16) * 255);
  }
  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.name = "Authored periodic tissue microstructure";
  texture.format = THREE.RGBAFormat; texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping; texture.wrapR = THREE.RepeatWrapping;
  texture.unpackAlignment = 1; texture.needsUpdate = true;
  return texture;
}

const breathingVertexGLSL = `
  float breathEnvelope = exp(-pow((position.y - 60.0) / 230.0, 2.0));
  transformed.x *= 1.0 + uSceneBreath * .004 * breathEnvelope;
  transformed.z *= 1.0 + uSceneBreath * .012 * breathEnvelope;
  transformed.y -= uSceneBreath * 1.4 * breathEnvelope;
`;
/** Shadow positions share exactly the authored breathing field used by the
 * visible surface. Coupled physics already arrives as CPU-deformed positions. */
export function makeWholeSceneDepthMaterial(breath: THREE.IUniform<number>): THREE.MeshDepthMaterial {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  material.customProgramCacheKey = () => `${WHOLE_SCENE_MATERIAL_VERSION}:breathing-depth`;
  material.onBeforeCompile = shader => {
    shader.uniforms.uSceneBreath = breath;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uSceneBreath;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${breathingVertexGLSL}`);
  };
  return material;
}

const tissueGLSL = `
varying vec3 vSceneRest;
varying float vSceneTissueOcclusion;
uniform highp sampler3D uSceneTissueVolume;
uniform float uTissueSeed;
uniform float uTissueDisease;
uniform float uTissueSelected;
uniform vec3 uTissueUndertone;
uniform vec4 uTissueProfile;
vec4 tissueField(vec3 p) { return texture(uSceneTissueVolume, fract(p)); }
vec3 sceneBump(vec3 p, vec3 n, float height, float orientation) {
  vec3 dx=dFdx(p), dy=dFdy(p), r1=cross(dy,n), r2=cross(n,dx);
  float det=dot(dx,r1)*orientation;
  if (abs(det) < length(cross(dx,dy))*1e-7) return n;
  return normalize(abs(det)*n-sign(det)*(dFdx(height)*r1+dFdy(height)*r2));
}
`;

export function makeWholeSceneTissueMaterial(part: TissuePart, variation: WholeSceneVariation, breath: THREE.IUniform<number>, volume: THREE.Data3DTexture, options: { bowelFrontSide?: boolean; reference?: ReferenceColor | undefined } = {}) {
  const tissue = wholeSceneTissue(part.id, part.category, variation), profile = profileFor(part);
  const color = new THREE.Color(profile.color), hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  color.setHSL(hsl.h + tissue.hueShift, Math.min(1, hsl.s * tissue.saturation), Math.max(0, Math.min(1, hsl.l * tissue.lightness)));
  const undertone = new THREE.Color(profile.undertone);
  if (options.reference) {
    const organ = REFERENCE_ORGAN_IDS[part.id];
    if (!organ) throw new Error("This structure has no reference-colour mapping");
    validateReferenceColor(options.reference, organ);
    for (const value of [color, undertone]) {
      const source = value.clone().convertLinearToSRGB();
      // Undertone retains its relative lightness and authored spatial field.
      const ref = value === undertone ? { ...options.reference, mode: "chroma" as const } : options.reference;
      value.setRGB(...referenceBaseColor([source.r, source.g, source.b], ref), THREE.SRGBColorSpace);
    }
  }
  const scaffold = part.category === "skeleton" || part.category === "connective";
  const roughness = Math.max(.24, Math.min(.8, profile.roughness + tissue.roughness - (part.category === "skeleton" ? .6 : .43)));
  const material = new THREE.MeshPhysicalMaterial({
    color, metalness: 0, roughness, ior: 1.38, specularIntensity: part.id === "liver" ? .58 : .72,
    clearcoat: profile.wetness, clearcoatRoughness: .23,
    envMapIntensity: scaffold ? .26 : .34,
    transparent: scaffold, opacity: part.category === "skeleton" ? .19 : part.id === "mesentery" ? .34 : part.category === "connective" ? .17 : 1,
    depthWrite: !scaffold, side: options.bowelFrontSide && (part.id === "small-intestine" || part.id === "colon") ? THREE.FrontSide : THREE.DoubleSide,
  });
  material.userData.selectionUniform = { value: 0 };
  material.customProgramCacheKey = () => `${WHOLE_SCENE_MATERIAL_VERSION}:${profile.type}`;
  material.onBeforeCompile = shader => {
    shader.uniforms.uSceneBreath = breath;
    shader.uniforms.uTissueSelected = material.userData.selectionUniform as THREE.IUniform<number>;
    shader.uniforms.uSceneTissueVolume = { value: volume };
    shader.uniforms.uTissueSeed = { value: tissue.seed };
    shader.uniforms.uTissueDisease = { value: tissue.disease };
    shader.uniforms.uTissueUndertone = { value: undertone };
    shader.uniforms.uTissueProfile = { value: new THREE.Vector4(profile.detailMm, profile.pigment * tissue.mottling / .15, profile.structure, profile.reliefMm) };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 sceneRestPosition;\nattribute float sceneTissueOcclusion;\nvarying vec3 vSceneRest;\nvarying float vSceneTissueOcclusion;\nuniform float uSceneBreath;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vSceneRest = sceneRestPosition;
        vSceneTissueOcclusion = sceneTissueOcclusion;
        ${breathingVertexGLSL}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n#define SCENE_TISSUE_KIND ${profile.type}\n${tissueGLSL}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec3 tissueP = vSceneRest + vec3(uTissueSeed * .371, uTissueSeed * .139, uTissueSeed * .713);
        float tissueFootprint = max(length(dFdx(vSceneRest)), length(dFdy(vSceneRest)));
        float tissueFineFilter = 1.0 - smoothstep(.3, 1.8, tissueFootprint);
        float tissueStructureFilter = 1.0 - smoothstep(uTissueProfile.x*.3, uTissueProfile.x*1.4, tissueFootprint);
        vec4 tissueCloud = tissueField(tissueP / 53.0);
        vec4 tissueCells = tissueField(tissueP / (uTissueProfile.x * 4.0));
        float tissueFine = mix(.5, tissueField(tissueP / 5.5).a, tissueFineFilter);
        float tissueBoundary = (1.0 - smoothstep(.045, .18, tissueCells.b)) * tissueStructureFilter;
        float tissueStructure = 0.0;
        float tissueRelief = tissueFine - .5;
        float sceneArteryMask = 0.0;
        float sceneVeinMask = 0.0;
        float sceneFatMask = 0.0;
        vec3 vascWarp = tissueP + (tissueCloud.gbr - .5) * 16.0;
        float vascU0 = sin(vascWarp.x * .17 + vascWarp.y * .13 - vascWarp.z * .11);
        float vascV0 = sin(vascWarp.x * .12 - vascWarp.y * .18 + vascWarp.z * .15);
        float vascSplit0 = max(vascV0, 0.0);
        float vascBranch1A = vascU0 - .44 * vascSplit0;
        float vascBranch1B = vascU0 + .38 * vascSplit0;
        float vascV1 = cos(vascWarp.x * .26 + vascWarp.y * .22 + vascWarp.z * .19);
        float vascSplit1 = max(vascV1, 0.0) * step(0.0, vascV0);
        float vascBranch2A = vascBranch1A - .28 * vascSplit1;
        float vascBranch2B = vascBranch1B + .25 * vascSplit1;
        float trunkMask = exp(-vascU0 * vascU0 * 420.0) * smoothstep(.35, -.15, vascV0);
        float gen1Mask = max(exp(-vascBranch1A * vascBranch1A * 680.0), exp(-vascBranch1B * vascBranch1B * 720.0)) * smoothstep(-.15, .20, vascV0) * .88;
        float gen2Mask = max(exp(-vascBranch2A * vascBranch2A * 1150.0), exp(-vascBranch2B * vascBranch2B * 1200.0)) * smoothstep(-.05, .25, vascV1) * .72 * tissueFineFilter;
        float rawArtery = max(trunkMask, max(gen1Mask, gen2Mask)) * tissueStructureFilter;
        float veinU0 = vascU0 + .12 + .03 * sin(vascWarp.z * .35);
        float veinBranch1A = veinU0 - .42 * vascSplit0;
        float veinBranch1B = veinU0 + .40 * vascSplit0;
        float rawVein = max(
          exp(-veinU0 * veinU0 * 340.0) * smoothstep(.35, -.15, vascV0),
          max(exp(-veinBranch1A * veinBranch1A * 560.0), exp(-veinBranch1B * veinBranch1B * 590.0)) * smoothstep(-.15, .20, vascV0) * .86
        ) * (1.0 - .80 * rawArtery) * tissueStructureFilter;
        float rawFatHalo = exp(-vascU0 * vascU0 * 32.0) * pow(clamp(1.0 - tissueCells.g * .92, 0.0, 1.0), 1.5) * (1.0 - .92 * max(rawArtery, rawVein));
        #if SCENE_TISSUE_KIND == 0
          // Solid parenchymal capsule (liver, spleen, kidney): smooth wet capsule with subcapsular venules & arterioles
          tissueStructure = tissueBoundary * .42;
          sceneArteryMask = rawArtery * .48;
          sceneVeinMask = rawVein * .64;
          sceneFatMask = 0.0;
          tissueRelief += (tissueCells.g - .55) * .28 + (sceneArteryMask + sceneVeinMask) * .55;
        #elif SCENE_TISSUE_KIND == 1
          // Subpleural lobular reticulation & pleural vessels
          tissueStructure = tissueBoundary * (.68 + tissueCloud.r*.32);
          sceneArteryMask = rawArtery * .48;
          sceneVeinMask = rawVein * .58;
          tissueRelief += (tissueCells.g - .55) * .75 + (sceneArteryMask + sceneVeinMask) * .55;
        #elif SCENE_TISSUE_KIND == 2
          // Hollow visceral serosa (stomach, small intestine, colon, duodenum, gallbladder):
          // Rich branching vasa recta / gastroepiploic / cystic vascular arcades & perivascular yellow fat lobules
          vec4 tissueStretch = tissueField(tissueP / vec3(uTissueProfile.x*6.5, uTissueProfile.x*3.0, uTissueProfile.x*4.0));
          tissueStructure = (1.0-smoothstep(.025,.105,tissueStretch.b)) * smoothstep(.32,.62,tissueCloud.r) * tissueStructureFilter;
          sceneArteryMask = clamp(rawArtery * .90 + tissueStructure * .28, 0.0, .92);
          sceneVeinMask = clamp(rawVein * .84 * (1.0 - .78 * sceneArteryMask), 0.0, .86);
          sceneFatMask = clamp((rawFatHalo - .18) * 1.9, 0.0, .74) * tissueStructureFilter;
          tissueRelief += (tissueCells.a - .5)*.28 + (sceneArteryMask + sceneVeinMask) * 1.15 + sceneFatMask * .75;
        #elif SCENE_TISSUE_KIND == 3
          // Pancreas & mesentery: lobulated acinar / adipose domes + interlobular vessels
          tissueStructure = tissueBoundary * .88;
          sceneArteryMask = rawArtery * .68;
          sceneVeinMask = rawVein * .64;
          sceneFatMask = clamp((rawFatHalo - .14) * 2.2, 0.0, .82) * tissueStructureFilter;
          tissueRelief += (tissueCells.g - .5) * 1.35 + (sceneArteryMask + sceneVeinMask) * .95;
        #elif SCENE_TISSUE_KIND == 4
          // Myocardium / diaphragm / muscular wall: coronary & phrenic vessels over muscle fibers
          float tissueFiber = sin(tissueP.x*2.6 + tissueP.z*.38 + tissueCloud.r*6.0);
          tissueStructure = (tissueFiber*.5+.5)*.7*tissueFineFilter;
          sceneArteryMask = rawArtery * .64;
          sceneVeinMask = rawVein * .58;
          sceneFatMask = clamp((rawFatHalo - .20) * 1.8, 0.0, .55);
          tissueRelief += tissueFiber*.3*tissueFineFilter + (sceneArteryMask + sceneVeinMask) * .75;
        #elif SCENE_TISSUE_KIND == 5
          // Great vessels & ducts: vasa vasorum micro-plexus on adventitia
          tissueStructure = (tissueCells.a*.55 + tissueFine*.45) * .35;
          sceneArteryMask = rawArtery * .42;
          sceneVeinMask = rawVein * .38;
          tissueRelief += (sceneArteryMask + sceneVeinMask) * .45;
        #else
          tissueStructure = tissueCells.g * .2;
          tissueRelief += (tissueCells.a-.5)*.3;
        #endif
        diffuseColor.rgb *= 1.0 + (tissueCloud.r-.5)*uTissueProfile.y*1.7 + (tissueCells.a-.5)*uTissueProfile.y*.35;
        diffuseColor.rgb = mix(diffuseColor.rgb, uTissueUndertone, tissueStructure*uTissueProfile.z);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.78, .60, .18), sceneFatMask * .68);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.14, .032, .20), sceneVeinMask * .74);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.66, .042, .035), sceneArteryMask * .82);
        float tissuePatch = smoothstep(.49,.76,tissueField(tissueP/91.0).r);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*vec3(.70,.37,.41), uTissueDisease*tissuePatch*.65);
        float tissueHeight = tissueRelief*uTissueProfile.w * 1.45;`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + (tissueCloud.r-.5)*.095 + (tissueFine-.5)*.045 - max(sceneArteryMask, sceneVeinMask)*.16 - sceneFatMask*.08, .20, .85);")
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\nnormal = sceneBump(-vViewPosition, normal, tissueHeight, faceDirection);")
      .replace("#include <clearcoat_normal_fragment_maps>", "#include <clearcoat_normal_fragment_maps>\n#ifdef USE_CLEARCOAT\nclearcoatNormal = sceneBump(-vViewPosition, clearcoatNormal, tissueHeight*.4, faceDirection);\n#endif")
      .replace("#include <aomap_fragment>", "#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= .65 + .35 * clamp(vSceneTissueOcclusion, 0.0, 1.0);")
      .replace("#include <opaque_fragment>", "float tissueSelectionRim = pow(1.0 - abs(dot(normal, normalize(vViewPosition))), 4.0);\noutgoingLight += uTissueSelected * tissueSelectionRim * vec3(.028, .058, .049);\n#include <opaque_fragment>");
  };
  return { material, signature: JSON.stringify({ version: WHOLE_SCENE_MATERIAL_VERSION, profile: profile.name, profileParameters: profile, color: color.getHexString(), opticalRoughness: roughness, opticalSpecular: material.specularIntensity, sidedness: material.side, ...tissue, ...(options.reference ? { reference_color: options.reference } : {}) }) };
}
