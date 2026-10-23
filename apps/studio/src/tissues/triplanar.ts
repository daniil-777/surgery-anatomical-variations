import * as THREE from "three";

/** Reference math for axis-handedness and zero-relief invariance tests. */
export function triplanarBasis(normal: THREE.Vector3) {
  const n = normal.clone().normalize(), signs = new THREE.Vector3(n.x < 0 ? -1 : 1, n.y < 0 ? -1 : 1, n.z < 0 ? -1 : 1);
  const weights = new THREE.Vector3(n.x ** 4, n.y ** 4, n.z ** 4); weights.divideScalar(weights.x + weights.y + weights.z);
  return { n, weights, u: [new THREE.Vector3(0, 0, -signs.x), new THREE.Vector3(1, 0, 0), new THREE.Vector3(signs.z, 0, 0)], v: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -signs.y), new THREE.Vector3(0, 1, 0)] };
}
export function projectedTriplanarNormal(normal: THREE.Vector3, encodedNormals: readonly THREE.Vector3[], gain = 1) {
  const { n, weights, u, v } = triplanarBasis(normal), perturbation = new THREE.Vector3();
  for (let axis = 0; axis < 3; axis++) {
    const map = encodedNormals[axis]!;
    perturbation.addScaledVector(u[axis]!, gain * weights.getComponent(axis) * map.x / Math.max(map.z, .05));
    perturbation.addScaledVector(v[axis]!, gain * weights.getComponent(axis) * map.y / Math.max(map.z, .05));
  }
  return n.clone().add(perturbation.addScaledVector(n, -perturbation.dot(n))).normalize();
}

/** Stable rest-space projection with surface-gradient normals; not blended axis normals.
 * Basis: Mikkelsen 2020, https://jcgt.org/published/0009/03/04/ .
 * Blending gradients preserves the original smooth normal when relief is flat.
 */
export function applyTriplanar(shader: THREE.WebGLProgramParametersWithUniforms, role: string, dynamicRelief: boolean) {
  shader.vertexShader = 'varying vec3 vTissueRestPosition; varying vec3 vTissueRestNormal;\n' + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTissueRestPosition = position; vTissueRestNormal = normal;');
  const declaration = `
    varying vec3 vTissueRestPosition; varying vec3 vTissueRestNormal;
    uniform mat3 tissueNormalMatrix;
    uniform float tissueBakeActive;
    uniform float tissueBakeSharpness;
    uniform vec3 tissueBakeMeanLinear;
    vec3 tissueProjectionWeights() {
      float expVal = tissueBakeActive > 0.5 ? tissueBakeSharpness : 4.0;
      vec3 w = pow(abs(normalize(vTissueRestNormal)), vec3(expVal));
      return w / max(w.x+w.y+w.z, 1e-8);
    }
    vec2 tissueUvX() { return vec2(vTissueRestPosition.z, vTissueRestPosition.y) / tissueTileMm; }
    vec2 tissueUvY() { return vec2(vTissueRestPosition.x, vTissueRestPosition.z) / tissueTileMm; }
    vec2 tissueUvZ() { return vec2(vTissueRestPosition.x, vTissueRestPosition.y) / tissueTileMm; }
    vec4 tissueSampleChannel(sampler2D tex, vec2 ignoredUv) {
      vec3 w = tissueProjectionWeights();
      if (tissueBakeActive > 0.5) {
        vec3 p = vTissueRestPosition / tissueTileMm;
        vec2 ux1 = vec2(0.9659258*p.z - 0.2588190*p.y + 0.173, 0.2588190*p.z + 0.9659258*p.y + 0.618);
        vec2 ux2 = vec2(0.5000000*p.z + 0.8660254*p.y, -0.8660254*p.z + 0.5000000*p.y) * 0.618034 + vec2(0.419, 0.831);
        vec2 uy1 = vec2(0.8660254*p.x + 0.5000000*p.z + 0.382, -0.5000000*p.x + 0.8660254*p.z + 0.236);
        vec2 uy2 = vec2(0.2588190*p.x - 0.9659258*p.z, 0.9659258*p.x + 0.2588190*p.z) * 0.618034 + vec2(0.712, 0.194);
        vec2 uz1 = vec2(0.9396926*p.x - 0.3420201*p.y + 0.754, 0.3420201*p.x + 0.9396926*p.y + 0.569);
        vec2 uz2 = vec2(0.3420201*p.x + 0.9396926*p.y, -0.9396926*p.x + 0.3420201*p.y) * 0.618034 + vec2(0.291, 0.647);
        vec4 sx = 0.70 * texture2D(tex, ux1) + 0.30 * texture2D(tex, ux2);
        vec4 sy = 0.70 * texture2D(tex, uy1) + 0.30 * texture2D(tex, uy2);
        vec4 sz = 0.70 * texture2D(tex, uz1) + 0.30 * texture2D(tex, uz2);
        return sx * w.x + sy * w.y + sz * w.z;
      }
      return texture2D(tex,tissueUvX())*w.x + texture2D(tex,tissueUvY())*w.y + texture2D(tex,tissueUvZ())*w.z;
    }
    vec4 tissueSample(sampler2D tex, vec2 ignoredUv) {
      vec3 w = tissueProjectionWeights();
      if (tissueBakeActive > 0.5) {
        vec3 p = vTissueRestPosition / tissueTileMm;
        vec2 ux1 = vec2(0.9659258*p.z - 0.2588190*p.y + 0.173, 0.2588190*p.z + 0.9659258*p.y + 0.618);
        vec2 ux2 = vec2(0.5000000*p.z + 0.8660254*p.y, -0.8660254*p.z + 0.5000000*p.y) * 0.618034 + vec2(0.419, 0.831);
        vec2 uy1 = vec2(0.8660254*p.x + 0.5000000*p.z + 0.382, -0.5000000*p.x + 0.8660254*p.z + 0.236);
        vec2 uy2 = vec2(0.2588190*p.x - 0.9659258*p.z, 0.9659258*p.x + 0.2588190*p.z) * 0.618034 + vec2(0.712, 0.194);
        vec2 uz1 = vec2(0.9396926*p.x - 0.3420201*p.y + 0.754, 0.3420201*p.x + 0.9396926*p.y + 0.569);
        vec2 uz2 = vec2(0.3420201*p.x + 0.9396926*p.y, -0.9396926*p.x + 0.3420201*p.y) * 0.618034 + vec2(0.291, 0.647);
        vec4 tx1 = texture2D(tex, ux1), tx2 = texture2D(tex, ux2);
        vec4 ty1 = texture2D(tex, uy1), ty2 = texture2D(tex, uy2);
        vec4 tz1 = texture2D(tex, uz1), tz2 = texture2D(tex, uz2);
        vec3 dx = (0.70 * (tx1.rgb - tissueBakeMeanLinear) + 0.30 * (tx2.rgb - tissueBakeMeanLinear)) * 1.313064;
        vec3 dy = (0.70 * (ty1.rgb - tissueBakeMeanLinear) + 0.30 * (ty2.rgb - tissueBakeMeanLinear)) * 1.313064;
        vec3 dz = (0.70 * (tz1.rgb - tissueBakeMeanLinear) + 0.30 * (tz2.rgb - tissueBakeMeanLinear)) * 1.313064;
        float normW = max(length(w), 0.58);
        vec3 rgb = clamp(tissueBakeMeanLinear + (dx * w.x + dy * w.y + dz * w.z) / normW, 0.0, 1.0);
        float alpha = (0.70 * tx1.a + 0.30 * tx2.a) * w.x + (0.70 * ty1.a + 0.30 * ty2.a) * w.y + (0.70 * tz1.a + 0.30 * tz2.a) * w.z;
        return vec4(rgb, alpha);
      }
      return texture2D(tex,tissueUvX())*w.x + texture2D(tex,tissueUvY())*w.y + texture2D(tex,tissueUvZ())*w.z;
    }
    vec3 tissueTriplanarGradient() {
      vec3 w=tissueProjectionWeights(), n=normalize(vTissueRestNormal);
      if (tissueBakeActive > 0.5) {
        vec3 p = vTissueRestPosition / tissueTileMm;
        vec2 ux1 = vec2(0.9659258*p.z - 0.2588190*p.y + 0.173, 0.2588190*p.z + 0.9659258*p.y + 0.618);
        vec2 ux2 = vec2(0.5000000*p.z + 0.8660254*p.y, -0.8660254*p.z + 0.5000000*p.y) * 0.618034 + vec2(0.419, 0.831);
        vec2 uy1 = vec2(0.8660254*p.x + 0.5000000*p.z + 0.382, -0.5000000*p.x + 0.8660254*p.z + 0.236);
        vec2 uy2 = vec2(0.2588190*p.x - 0.9659258*p.z, 0.9659258*p.x + 0.2588190*p.z) * 0.618034 + vec2(0.712, 0.194);
        vec2 uz1 = vec2(0.9396926*p.x - 0.3420201*p.y + 0.754, 0.3420201*p.x + 0.9396926*p.y + 0.569);
        vec2 uz2 = vec2(0.3420201*p.x + 0.9396926*p.y, -0.9396926*p.x + 0.3420201*p.y) * 0.618034 + vec2(0.291, 0.647);
        vec3 a = normalize(mix(tissueCompositeNormal(ux1), tissueCompositeNormal(ux2), 0.3));
        vec3 b = normalize(mix(tissueCompositeNormal(uy1), tissueCompositeNormal(uy2), 0.3));
        vec3 c = normalize(mix(tissueCompositeNormal(uz1), tissueCompositeNormal(uz2), 0.3));
        float normW = max(length(w), 0.58);
        vec3 g = (vec3(0.0,a.y,a.x)*(w.x/max(a.z,0.1)) + vec3(b.x,0.0,b.y)*(w.y/max(b.z,0.1)) + vec3(c.x,c.y,0.0)*(w.z/max(c.z,0.1))) / normW;
        return g-n*dot(n,g);
      }
      vec3 a=tissueCompositeNormal(tissueUvX()), b=tissueCompositeNormal(tissueUvY()), c=tissueCompositeNormal(tissueUvZ());
      vec3 g=vec3(0.0,a.y,a.x)*(w.x/max(a.z,0.05)) + vec3(b.x,0.0,b.y)*(w.y/max(b.z,0.05)) + vec3(c.x,c.y,0.0)*(w.z/max(c.z,0.05));
      return g-n*dot(n,g);
    }
  `;
  // Insert after the shared relief helper so its uniforms/function are already declared.
  const main = shader.fragmentShader.indexOf('void main()');
  if (main < 0) throw new Error('Tissue shader has no main function');
  const fallback = dynamicRelief ? '' : 'uniform float tissueTileMm; uniform sampler2D tissueBaseNormal; vec3 tissueCompositeNormal(vec2 uv){return texture2D(tissueBaseNormal,uv).xyz*2.0-1.0;}\n';
  shader.fragmentShader = shader.fragmentShader.slice(0, main) + fallback + declaration + shader.fragmentShader.slice(main);
  if (role === 'normal' && !dynamicRelief) shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', 'diffuseColor.rgb = normalize(normalize(vTissueRestNormal) + tissueTriplanarGradient()) * 0.5 + 0.5;');
  shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', THREE.ShaderChunk.map_fragment).replace('#include <roughnessmap_fragment>', THREE.ShaderChunk.roughnessmap_fragment);
  shader.fragmentShader = shader.fragmentShader.replace(/texture2D\(\s*map\s*,\s*vMapUv\s*\)/g, 'tissueSample(map, vMapUv)');
  const channelSampling = /texture2D\(\s*(roughnessMap|tissueVessels|tissueFascia|tissueAdipose|tissueWet|tissueDryRoughness)\s*,\s*(vMapUv|vRoughnessMapUv)\s*\)/g;
  shader.fragmentShader = shader.fragmentShader.replace(channelSampling, 'tissueSampleChannel($1, $2)');
  if (role === 'normal') shader.fragmentShader = shader.fragmentShader.replace('diffuseColor.rgb = tissueCompositeNormal(vMapUv) * 0.5 + 0.5;', 'diffuseColor.rgb = normalize(normalize(vTissueRestNormal) + tissueTriplanarGradient()) * 0.5 + 0.5;');
  if (role === 'lit') {
    // The UV derivative TBN is deliberately unused: atlas surfaces contain no UV charts.
    const start = shader.fragmentShader.indexOf('#include <normal_fragment_begin>');
    const end = shader.fragmentShader.indexOf('#include <clearcoat_normal_fragment_begin>', start);
    if (start < 0 || end < 0) throw new Error('Unexpected physical normal shader chunks');
    shader.fragmentShader = shader.fragmentShader.slice(0, start) + `float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
      vec3 normal = normalize(vNormal);
      vec3 nonPerturbedNormal = normal;
      vec3 tissueRestN = normalize(vTissueRestNormal), tissueGradient = tissueTriplanarGradient();
      normal = normalize(tissueNormalMatrix * normalize(tissueRestN + tissueGradient * normalScale.x));
    ` + shader.fragmentShader.slice(end);
    const coatStart = shader.fragmentShader.indexOf('#include <clearcoat_normal_fragment_begin>');
    const coatEnd = shader.fragmentShader.indexOf('#include <emissivemap_fragment>', coatStart);
    if (coatEnd < 0) throw new Error('Unexpected clearcoat shader chunks');
    shader.fragmentShader = shader.fragmentShader.slice(0, coatStart) + `#include <clearcoat_normal_fragment_begin>
      #ifdef USE_CLEARCOAT_NORMALMAP
        clearcoatNormal = normalize(tissueNormalMatrix * normalize(tissueRestN + tissueGradient * clearcoatNormalScale.x));
      #endif
    ` + shader.fragmentShader.slice(coatEnd);
  }
}
