import * as THREE from "three";
import type { TissueControls, TissueManifest } from "./contracts";
import type { TissueMaps } from "./assets";
import { applyTriplanar } from "./triplanar";
import { defaultMaterialVariation, materialSeedOffsets, tissueVariationShader, validateMaterialVariation } from "./materialVariation";

/** Normal-incidence dielectric boundary reflectance, not a tissue measurement. */
export function dielectricInterfaceF0(incidentIor: number, transmittedIor: number) {
  if (![incidentIor, transmittedIor].every(value => Number.isFinite(value) && value >= 1)) throw new RangeError("Visible-light dielectric indices must be finite and at least 1");
  const ratio = (transmittedIor - incidentIor) / (transmittedIor + incidentIor);
  return ratio * ratio;
}
const AUTHORED_WATER_FILM_IOR = 1.333;

/** Authored rendering parameters, not fitted tissue optical measurements. */
export function appearanceProfile(organ: string) {
  const mucosa = organ.endsWith("_mucosa");
  return { normalScale: mucosa ? .85 : .65, coatNormalScale: mucosa ? .40 : .30, coatRoughness: mucosa ? .095 : .13, ior: 1.38 };
}

/** Stable material instances and shared uniforms; slider edits never rebuild shaders. */
export function createTissueMaterial(maps: TissueMaps, manifest: TissueManifest, controls: TissueControls, projection: "uv" | "triplanar" = "uv") {
  const profile = appearanceProfile(manifest.recipe.organ);
  const dynamicRelief = Boolean(maps.substrate_normal && maps.layer_relief);
  const scales = manifest.channels.layer_relief?.decode_scale_mm ?? [0, 0, 0];
  const coverage = { value: new THREE.Vector3() }, wetness = { value: controls.wetness };
  const uniforms = { tissueBakeActive: { value: 0 }, tissueBakeSharpness: { value: 6 }, tissueBakeMeanLinear: { value: new THREE.Vector3(0.18, 0.05, 0.04) }, tissueVariationEnabled: { value: 0 }, tissueVariationSeed: { value: new THREE.Vector3() }, tissueVariationAmounts: { value: new THREE.Vector4() }, tissueVariationTileMm: { value: manifest.recipe.tile_size_mm }, tissueWetInterfaceF0: { value: dielectricInterfaceF0(AUTHORED_WATER_FILM_IOR, profile.ior) }, tissueNormalMatrix: { value: new THREE.Matrix3() }, tissueVessels: { value: maps.vessels }, tissueFascia: { value: maps.fascia }, tissueAdipose: { value: maps.adipose }, tissueWet: { value: maps.wet_film }, tissueCoverage: coverage, tissueWetness: wetness, tissueDryRoughness: { value: maps.substrate_roughness ?? maps.roughness },
    tissueBaseNormal: { value: maps.substrate_normal ?? maps.normal }, tissueRelief: { value: maps.layer_relief ?? maps.roughness },
    tissueReliefScale: { value: new THREE.Vector3(scales[0], scales[1], scales[2]) },
    tissueTexel: { value: 1 / manifest.resolution[0] }, tissueTileMm: { value: manifest.recipe.tile_size_mm },
  };
  const physical = new THREE.MeshPhysicalMaterial({ map: maps.substrate, normalMap: maps.substrate_normal ?? maps.normal, normalScale: new THREE.Vector2(profile.normalScale, profile.normalScale), roughnessMap: maps.substrate_roughness ?? maps.roughness, roughness: 1, clearcoat: 1, clearcoatRoughness: profile.coatRoughness, clearcoatNormalMap: maps.substrate_normal ?? maps.normal, clearcoatNormalScale: new THREE.Vector2(profile.coatNormalScale, profile.coatNormalScale), ior: profile.ior, metalness: 0 });
  const albedo = new THREE.MeshBasicMaterial({ map: maps.substrate, toneMapped: false });
  const normal = new THREE.MeshBasicMaterial({ map: maps.normal, toneMapped: false });
  const roughness = new THREE.MeshBasicMaterial({ map: maps.roughness, toneMapped: false });
  albedo.fog = normal.fog = roughness.fog = false;
  for (const [role, material] of Object.entries({ lit: physical, albedo, normal, roughness })) {
    material.onBeforeRender = (_renderer, _scene, camera, _geometry, object) => {
      if (projection === "triplanar") uniforms.tissueNormalMatrix.value.getNormalMatrix(new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld));
    };
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = "varying vec3 vTissueVariationPosition;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>\nvTissueVariationPosition = ${projection === "triplanar" ? "position" : "vec3(uv, 0.0)"};`);
      shader.fragmentShader = "varying vec3 vTissueVariationPosition; uniform float tissueVariationTileMm;\n" + tissueVariationShader + shader.fragmentShader;
      const variationPosition = projection === "triplanar" ? "vTissueVariationPosition / tissueVariationTileMm" : "vTissueVariationPosition";
      shader.fragmentShader = shader.fragmentShader.replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\nroughnessFactor = tissueVaryRoughness(roughnessFactor, ${variationPosition});`);
      // Data diagnostics show encoded channel values directly, without an sRGB transfer.
      if (role === "normal" || role === "roughness") shader.fragmentShader = shader.fragmentShader.replace("#include <colorspace_fragment>", "");
      shader.fragmentShader = `uniform sampler2D tissueVessels; uniform sampler2D tissueFascia; uniform sampler2D tissueAdipose; uniform sampler2D tissueWet; uniform sampler2D tissueDryRoughness; uniform vec3 tissueCoverage; uniform float tissueWetness; uniform float tissueWetInterfaceF0;\n${shader.fragmentShader}`;
      if (dynamicRelief) {
        shader.fragmentShader = `uniform sampler2D tissueBaseNormal; uniform sampler2D tissueRelief;
          uniform vec3 tissueReliefScale; uniform float tissueTexel; uniform float tissueTileMm;
          vec3 tissueCompositeNormal(vec2 uv) {
            vec3 baseN = texture2D(tissueBaseNormal, uv).xyz * 2.0 - 1.0;
            vec3 weights = tissueReliefScale * tissueCoverage.xzy;
            vec2 du = vec2(tissueTexel, 0.0), dv = vec2(0.0, tissueTexel);
            float dx = dot(texture2D(tissueRelief, uv + du).rgb - texture2D(tissueRelief, uv - du).rgb, weights);
            float dy = dot(texture2D(tissueRelief, uv + dv).rgb - texture2D(tissueRelief, uv - dv).rgb, weights);
            vec2 slopes = baseN.xy / max(baseN.z, 0.05) - vec2(dx, dy) / (2.0 * tissueTexel * tissueTileMm);
            return normalize(vec3(slopes, 1.0));
          }
${shader.fragmentShader}`;
        // Shared coverage must be declared before the helper function.
        shader.fragmentShader = shader.fragmentShader.replace("uniform vec3 tissueCoverage;", "");
        shader.fragmentShader = "uniform vec3 tissueCoverage;\n" + shader.fragmentShader;
        shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>", THREE.ShaderChunk.normal_fragment_maps.replaceAll("texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0", "tissueCompositeNormal(vNormalMapUv)"));
        shader.fragmentShader = shader.fragmentShader.replace("#include <clearcoat_normal_fragment_maps>", THREE.ShaderChunk.clearcoat_normal_fragment_maps.replace("texture2D( clearcoatNormalMap, vClearcoatNormalMapUv ).xyz * 2.0 - 1.0", "tissueCompositeNormal(vClearcoatNormalMapUv)"));
      }
      if (material === roughness) {
        shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `
          float dryRoughness = tissueVaryRoughness(texture2D(tissueDryRoughness, vMapUv).r, ${variationPosition});
          float fasciaCover = texture2D(tissueFascia, vMapUv).a * tissueCoverage.y;
          float filmCover = texture2D(tissueWet, vMapUv).a * tissueWetness;
          diffuseColor.rgb = vec3(${maps.substrate_roughness ? "clamp((dryRoughness + 0.10 * fasciaCover) * (1.0 - 0.57 * filmCover), 0.075, 0.85)" : "dryRoughness"});`);
        if (projection === "triplanar") applyTriplanar(shader, role, dynamicRelief);
        return;
      }
      if (material === normal) {
        if (dynamicRelief) shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", "diffuseColor.rgb = tissueCompositeNormal(vMapUv) * 0.5 + 0.5;");
        if (projection === "triplanar") applyTriplanar(shader, role, dynamicRelief);
        return;
      }
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>
        diffuseColor.rgb = tissueVaryPigment(diffuseColor.rgb, ${variationPosition});
        vec4 tv = texture2D(tissueVessels, vMapUv);
        vec4 tf = texture2D(tissueFascia, vMapUv);
        vec4 ta = texture2D(tissueAdipose, vMapUv);
        diffuseColor.rgb = mix(diffuseColor.rgb, tv.rgb, tv.a * tissueCoverage.x);
        diffuseColor.rgb = mix(diffuseColor.rgb, ta.rgb, ta.a * tissueCoverage.z);
        diffuseColor.rgb = mix(diffuseColor.rgb, tf.rgb, tf.a * tissueCoverage.y);`);
      shader.fragmentShader = shader.fragmentShader.replace("#include <lights_physical_fragment>", `float tissueCoat = tissueWetness * texture2D(tissueWet, vMapUv).a;
        // Adjust the microfacet parameter before Three adds the geometry antialias floor.
        ${maps.substrate_roughness ? "roughnessFactor = clamp((roughnessFactor + 0.10 * tf.a * tissueCoverage.y) * (1.0 - 0.57 * tissueCoat), 0.075, 0.85);" : "// Legacy manifest roughness is already baked: do not apply wetness twice."}
        #include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          material.clearcoat *= tissueCoat;
          // Spatial film roughness is an authored response to coverage/substrate grain,
          // preserving Three's geometric antialias floor rather than a uniform mirror film.
          float tissueFilmRoughness = clearcoatRoughness + 0.12 * (1.0 - tissueCoat) + 0.10 * tissueVaryRoughness(texture2D(tissueDryRoughness, vMapUv).r, ${variationPosition});
          material.clearcoatRoughness = max(material.clearcoatRoughness, clamp(tissueFilmRoughness, 0.06, 0.4));
          // Water film's Fresnel reflectance; Three's default clearcoat assumes IOR 1.5.
          material.clearcoatF0 = vec3(0.02037);
          #ifdef IOR
            // Authored nested-interface approximation: only the covered substrate F0 changes.
            // Keep Three's later clearcoat composition; do not apply another (1 - F) factor here.
            // The explicit branch preserves the dry material exactly.
            if (material.clearcoat > 0.0) {
              vec3 tissueWetSpecular = min(vec3(tissueWetInterfaceF0) * specularColorFactor, vec3(1.0)) * specularIntensityFactor;
              material.specularColor = mix(material.specularColor, tissueWetSpecular, material.clearcoat);
              material.specularColorBlended = mix(material.specularColor, diffuseColor.rgb, metalnessFactor);
            }
          #endif
        #endif`);
      if (projection === "triplanar") applyTriplanar(shader, role, dynamicRelief);
    };
    material.customProgramCacheKey = () => `viscera-tissue-spatial-film-v4-wet-interface-ablation-v1-material-variation-v1-${projection}-${role}-${dynamicRelief ? "editable" : "baked"}-${maps.substrate_roughness ? "dry" : "composite"}`;
  }
  const materials = { lit: physical, albedo, normal, roughness };
  let variationKey = "";
  const update = (value: TissueControls) => {
    const variation = validateMaterialVariation(value.materialVariation ?? defaultMaterialVariation);
    const nextKey = JSON.stringify(variation);
    if (nextKey !== variationKey) {
      uniforms.tissueVariationEnabled.value = variation.enabled ? 1 : 0;
      uniforms.tissueVariationSeed.value.set(...materialSeedOffsets(variation.seed));
      uniforms.tissueVariationAmounts.value.set(variation.warmth, variation.depth, variation.strength, variation.roughness);
      variationKey = nextKey;
    }
    coverage.value.set(value.vessels, value.fascia, value.adipose);
    wetness.value = value.wetness;
    return materials[value.study];
  };
  update(controls);
  // Both choices are non-null sRGB color maps with the same UV channel. Rebinding
  // changes only sampler data; the owner keeps and disposes each texture.
  const setSubstrate = (texture?: THREE.Texture) => { physical.map = albedo.map = texture ?? maps.substrate; };
  const setOrganBake = (bake?: { substrate: THREE.Texture; normal: THREE.Texture; roughness: THREE.Texture; tileScaleMm: number; blendSharpness: number; meanLinear?: readonly [number, number, number] }, fallbackSubstrate?: THREE.Texture) => {
    physical.map = albedo.map = bake?.substrate ?? fallbackSubstrate ?? maps.substrate;
    const normMap = bake?.normal ?? (maps.substrate_normal ?? maps.normal);
    const roughMap = bake?.roughness ?? (maps.substrate_roughness ?? maps.roughness);
    physical.normalMap = physical.clearcoatNormalMap = normMap;
    normal.map = bake?.normal ?? maps.normal;
    physical.roughnessMap = roughMap;
    roughness.map = bake?.roughness ?? maps.roughness;
    uniforms.tissueBaseNormal.value = normMap;
    uniforms.tissueDryRoughness.value = roughMap;
    uniforms.tissueBakeActive.value = bake ? 1 : 0;
    uniforms.tissueBakeSharpness.value = bake?.blendSharpness ?? 6;
    if (bake?.meanLinear) uniforms.tissueBakeMeanLinear.value.set(bake.meanLinear[0], bake.meanLinear[1], bake.meanLinear[2]);
    uniforms.tissueTileMm.value = bake?.tileScaleMm ?? manifest.recipe.tile_size_mm;
  };
  return { update, setSubstrate, setOrganBake, physical, uniforms, dispose: () => Object.values(materials).forEach(material => material.dispose()) };
}
