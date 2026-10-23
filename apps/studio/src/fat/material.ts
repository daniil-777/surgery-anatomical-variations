import * as THREE from "three";
import { FAT_TEXTURE_TILE_MM } from "./texture";
import { FAT_OPTICS } from "./optics";

export const FAT_MATERIAL_VERSION = "viscera-fat-triplanar-v5";
/** Authored relief amplitude, not measured tissue displacement. */
export const FAT_HEIGHT_AMPLITUDE_MM = .8;
export type FatSurfaceStudy = "tissue" | "color" | "relief" | "geometry";
export interface FatMaps { color: THREE.DataTexture; height: THREE.DataTexture; roughness: THREE.DataTexture; resolution: number }
export function fatDataTexture(data: Uint8Array, resolution: number, color = false): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, resolution, resolution, THREE.RGBAFormat);
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true; texture.needsUpdate = true;
  return texture;
}
export function disposeFatMaps(maps: FatMaps | null): void {
  if (maps) { maps.color.dispose(); maps.height.dispose(); maps.roughness.dispose(); }
}

/** Rest-space triplanar mapping avoids spherical UV pinching and follows deformation.
 * Wet dielectric highlights and authored relief are appearance parameters,
 * not measured optical coefficients. Direct-light diffusion is a bounded authored
 * approximation, not a calibrated subsurface transport solution. */
export function createFatMaterial(maps: FatMaps, wetness = .48, tileMm = FAT_TEXTURE_TILE_MM, study: FatSurfaceStudy = "tissue", anatomical = false, regionMap: THREE.DataTexture | null = null): THREE.MeshPhysicalMaterial {
  const material = new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0,
    roughness: .44, ior: 1.46, specularIntensity: .65, clearcoat: wetness,
    // Anatomical depots are closed outward-oriented shells, including their
    // undersides. Rendering their front faces avoids a redundant transmissive
    // backface prepass over almost coincident membrane surfaces.
    clearcoatRoughness: .18, envMapIntensity: .65, side: anatomical ? THREE.FrontSide : THREE.DoubleSide,
    // Thin intercord regions use the existing physical transmission pass.
    // This local shell proxy is not a measured serosal BSSRDF.
    transmission: anatomical ? .8 : 0, thickness: anatomical ? 1 : 0 });
  material.toneMapped = study !== "color";
  material.name = "Procedural white adipose / wet septal surface";
  material.customProgramCacheKey = () => `${FAT_MATERIAL_VERSION}:${anatomical}:${Boolean(regionMap)}`;
  const optics = { strength: { value: FAT_OPTICS.strength as number }, thicknessScale: { value: 1 } };
  const appearance = { study: { value: ["tissue", "color", "relief", "geometry"].indexOf(study) } };
  material.userData.fatOptics = optics;
  material.userData.fatAppearance = appearance;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, {
      uFatStudy: appearance.study, uFatColor: { value: maps.color }, uFatHeight: { value: maps.height },
      uFatRoughness: { value: maps.roughness }, uFatTileMm: { value: tileMm }, uFatHeightMm: { value: FAT_HEIGHT_AMPLITUDE_MM },
      uFatScatter: optics.strength, uFatThicknessScale: optics.thicknessScale,
      ...(regionMap ? {uFatRegionMap: {value:regionMap}} : {}),
      uFatAttenuationMm: { value: new THREE.Vector3(...FAT_OPTICS.attenuationLengthsMm) }, uFatWrap: { value: FAT_OPTICS.wrap },
    });
    shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>
      attribute vec3 fatRestPosition; attribute vec3 fatRestNormal; attribute float fatThicknessMm;
      ${anatomical ? "attribute vec3 fatRegion;" : ""}
      ${regionMap ? "attribute vec2 fatDepotUv; varying vec2 vFatDepotUv;" : ""}
      varying vec3 vFatRest; varying vec3 vFatNormal; varying float vFatThicknessMm; varying vec3 vFatRegion;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvFatRest = fatRestPosition; vFatNormal = fatRestNormal; vFatThicknessMm = fatThicknessMm; vFatRegion = ${anatomical ? "fatRegion" : "vec3(1.0, 0.0, 0.0)"}; ${regionMap ? "vFatDepotUv = fatDepotUv;" : ""}`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
      varying vec3 vFatRest; varying vec3 vFatNormal;
      varying float vFatThicknessMm; varying vec3 vFatRegion;
      ${regionMap ? "varying vec2 vFatDepotUv; uniform sampler2D uFatRegionMap;" : ""}
      uniform float uFatScatter; uniform float uFatThicknessScale; uniform vec3 uFatAttenuationMm; uniform float uFatWrap;
      uniform sampler2D uFatColor; uniform sampler2D uFatHeight; uniform sampler2D uFatRoughness;
      uniform float uFatTileMm; uniform float uFatHeightMm; uniform int uFatStudy;
      vec3 fatHalfVector(vec3 lightDir, vec3 viewDir, vec3 n) {
        vec3 sum = lightDir + viewDir;
        float squaredLength = dot(sum, sum);
        return squaredLength > 1e-10 ? sum * inversesqrt(squaredLength) : n;
      }
      vec3 fatDiffuseLobe(float cosine) {
        float front = max(cosine, 0.0), back = max(-cosine, 0.0);
        float wrapped = max(cosine + uFatWrap, 0.0) / ((1.0 + uFatWrap) * (1.0 + uFatWrap));
        vec3 transmitted = exp(-max(vFatThicknessMm * uFatThicknessScale, 0.0) / uFatAttenuationMm);
        float amount = uFatStudy == 0 ? uFatScatter : 0.0;
        return mix(vec3(front), mix(vec3(wrapped), vec3(back), transmitted), amount);
      }
      vec3 fatSafeNormal(vec3 n) {
        float lengthSquared = dot(n, n);
        return lengthSquared > 1e-12 && lengthSquared < 1e20 ? n * inversesqrt(lengthSquared) : vec3(0.0, 0.0, 1.0);
      }
      vec4 fatSample(sampler2D tex, vec3 p, vec3 n) {
        vec3 w = pow(abs(fatSafeNormal(n)), vec3(6.0)); w /= max(dot(w,vec3(1.0)),.00001);
        return texture2D(tex,p.yz)*w.x + texture2D(tex,p.xz)*w.y + texture2D(tex,p.xy)*w.z;
      }
      // Differentiate each planar height field, then blend its gradients. Taking
      // screen derivatives of the blended height also differentiates normal-based
      // blend weights, creating false horizontal ridges as the silhouette turns.
      vec2 fatPlanarGradient(vec2 uv) {
        float e = max(1.5 / 512.0, max(length(dFdx(uv)), length(dFdy(uv))));
        vec2 gradient = vec2(
          texture2D(uFatHeight,uv+vec2(e,0.0)).r-texture2D(uFatHeight,uv-vec2(e,0.0)).r,
          texture2D(uFatHeight,uv+vec2(0.0,e)).r-texture2D(uFatHeight,uv-vec2(0.0,e)).r);
        return gradient * uFatHeightMm / (2.0*e*uFatTileMm);
      }
      vec3 fatGradient(vec3 p, vec3 n) {
        vec3 w=pow(abs(fatSafeNormal(n)),vec3(6.0)); w/=max(dot(w,vec3(1.0)),.00001);
        vec2 x=fatPlanarGradient(p.yz), y=fatPlanarGradient(p.xz), z=fatPlanarGradient(p.xy);
        return vec3(0.0,x.x,x.y)*w.x + vec3(y.x,0.0,y.y)*w.y + vec3(z.x,z.y,0.0)*w.z;
      }
      vec3 fatBump(vec3 n, vec3 gradient) {
        vec3 p = -vViewPosition;
        vec3 dx=dFdx(p), dy=dFdy(p), r1=cross(dy,n), r2=cross(n,dx);
        // Derivatives must run in every fragment lane before any per-fragment
        // determinant branch. Otherwise grazing triangles invoke undefined
        // derivative behavior and can feed NaNs into physical transmission.
        vec3 restDx=dFdx(vFatRest), restDy=dFdy(vFatRest);
        float gx=dot(gradient,restDx), gy=dot(gradient,restDy);
        float det=dot(dx,r1);
        if(abs(det)<1e-10) return n;
        vec3 bumped=abs(det)*n - sign(det)*(gx*r1+gy*r2);
        float bumpedLengthSquared=dot(bumped,bumped);
        return bumpedLengthSquared > 1e-20 && bumpedLengthSquared < 1e20 ? bumped * inversesqrt(bumpedLengthSquared) : n;
      }`)
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec3 fatP = vFatRest / uFatTileMm;
        vec3 fatRegionValue = ${regionMap ? "texture2D(uFatRegionMap, vFatDepotUv).rgb" : "vFatRegion"};
        vec3 fatAlbedo = fatSample(uFatColor, fatP, vFatNormal).rgb;
        ${anatomical ? `
        // Coverage follows the SAME rest-space field as the geometric cords.
        // Colours are authored linear RGB, not sampled photographic lighting.
        fatAlbedo = mix(vec3(.72, .52, .40), fatAlbedo * vec3(.97, .85, .64), fatRegionValue.x);
        fatAlbedo = mix(fatAlbedo, vec3(.36, .055, .035), clamp(fatRegionValue.y * .30, 0.0, .30));` : ""}
        diffuseColor.rgb *= uFatStudy < 2 ? fatAlbedo : vec3(.55);`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = uFatStudy < 2 ? clamp(mix(fatSample(uFatRoughness, fatP, vFatNormal).r, .26, fatRegionValue.z * .65), .22, .82) : .6;`)
      .replace("#include <normal_fragment_begin>", THREE.ShaderChunk.normal_fragment_begin.replace("vec3 normal = normalize( vNormal );", `
        // Opposing shell normals can interpolate to zero along very thin rims.
        // Evaluate the geometric fallback before selecting it, keeping fragment
        // derivatives outside divergent control flow.
        vec3 fatFaceNormal = cross(dFdx(vViewPosition), dFdy(vViewPosition));
        float fatNormalLengthSquared = dot(vNormal, vNormal);
        vec3 normal = fatNormalLengthSquared > 1e-12 && fatNormalLengthSquared < 1e20
          ? vNormal * inversesqrt(fatNormalLengthSquared) : fatSafeNormal(fatFaceNormal) * faceDirection;`))
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        if (uFatStudy == 0 || uFatStudy == 2) normal = fatBump(normal, fatGradient(fatP,vFatNormal) * mix(1.0, .18, fatRegionValue.z));`)
      .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          // Smooth wet film varies with the broad roughness field. Its normal is
          // intentionally the geometric normal, independent of substrate relief.
          material.clearcoat *= .35 + .65 * (1.0 - smoothstep(.25, .50, roughnessFactor));
          material.clearcoatRoughness = ${anatomical ? "clamp(.05 + .18 * roughnessFactor, .06, .22)" : "clamp(.12 + .28 * roughnessFactor, .12, .35)"};
        #endif`)
      .replace("#include <opaque_fragment>", `
        if (uFatStudy == 1) outgoingLight = diffuseColor.rgb;
        #include <opaque_fragment>`);
    if (anatomical) {
      const transmission = THREE.ShaderChunk.transmission_fragment
        .replace("material.transmission = transmission;", "material.transmission = uFatStudy == 0 ? transmission * fatRegionValue.z * (1.0 - smoothstep(.3, 2.2, vFatThicknessMm)) : 0.0;")
        .replace("material.thickness = thickness;", "material.thickness = max(vFatThicknessMm * uFatThicknessScale, .05);");
      shader.fragmentShader = shader.fragmentShader.replace("#include <transmission_fragment>", transmission);
    }
    const directDiffuse = "reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution ) * ( 1.0 - F );";
    // At L=-V the reflective specular term has zero incident cosine, but its
    // intermediate half-vector must still be finite (0*NaN is not zero).
    const physical = THREE.ShaderChunk.lights_physical_pars_fragment
      .replaceAll("normalize( lightDir + viewDir )", "fatHalfVector(lightDir, viewDir, normal)")
      .replace("normalize( directLight.direction + geometryViewDir )", "fatHalfVector(directLight.direction, geometryViewDir, geometryNormal)")
      .replace("normalize( directLight.direction + retroViewDir )", "fatHalfVector(directLight.direction, retroViewDir, geometryNormal)");
    if (!physical.includes(directDiffuse)) throw new Error("Fat material requires review after the Three.js direct-light shader changed.");
    shader.fragmentShader = shader.fragmentShader.replace("#include <lights_physical_pars_fragment>", physical.replace(directDiffuse,
      `// A reflective L+V half-vector is undefined for exactly opposing light
       // and view. It must not extinguish the transmitted diffuse lobe.
       vec3 fatExit = vec3(1.0) - F_Schlick(material.specularColor, material.specularF90, saturate(dot(geometryNormal, geometryViewDir)));
       reflectedLight.directDiffuse += directLight.color * fatDiffuseLobe(dot(geometryNormal, directLight.direction)) * BRDF_Lambert( material.diffuseContribution ) * fatExit;`));
  };
  return material;
}

/** Change inspection controls without rebaking maps, regenerating anatomy or
 * replacing GPU materials. Shader uniforms survive context recompilation. */
export function updateFatAppearance(material: THREE.MeshPhysicalMaterial, wetness: number, study: FatSurfaceStudy): void {
  const index = ["tissue", "color", "relief", "geometry"].indexOf(study);
  if (!Number.isFinite(wetness) || wetness < 0 || wetness > 1 || index < 0) throw new RangeError("Invalid fat appearance controls");
  const previousCoat = material.clearcoat > 0;
  material.clearcoat = wetness;
  const toneMapped = study !== "color";
  if (material.toneMapped !== toneMapped || previousCoat !== (wetness > 0)) material.needsUpdate = true;
  material.toneMapped = toneMapped;
  const appearance = material.userData.fatAppearance;
  if (appearance) appearance.study.value = index;
}

export function updateFatOptics(material: THREE.Material, strength: number, thicknessScale = 1): void {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1 || !Number.isFinite(thicknessScale) || thicknessScale <= 0) throw new RangeError("Invalid fat optics controls");
  const optics = material.userData.fatOptics;
  if (optics) { optics.strength.value = strength; optics.thicknessScale.value = thicknessScale; }
}
