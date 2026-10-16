
uniform highp uint uAtlasSeed;
uniform vec3 uAtlasBaseColor;
uniform vec3 uAtlasLigamentColor;
uniform float uAtlasPigmentContrast;
uniform float uAtlasMottleScaleMm;
uniform float uAtlasWetness;
uniform float uAtlasFineDetail;
uniform float uAtlasStructureStrength;
uniform float uAtlasRoughnessBase;
uniform float uAtlasPigmentAmplitude;
uniform float uAtlasFineScaleMm;
uniform float uAtlasHeightAmplitudeMm;
uniform float uAtlasStructureScaleMm;
uniform int uAtlasStructureMode;
uniform vec3 uAtlasStructureStretch;
struct AtlasMaterialSample {
  vec3 colorLinear;
  float roughness;
  float heightMm;
  vec3 heightGradientRest;
  float clearcoat;
  float clearcoatRoughness;
};
float atlasLattice(ivec3 cell, uint seed) {
  uvec3 q = uvec3(cell);
  uint h = (q.x*73856093u) ^ (q.y*19349663u) ^ (q.z*83492791u) ^ seed;
  h ^= h >> 16u; h *= 2246822519u; h ^= h >> 13u;
  h *= 3266489917u; h ^= h >> 16u;
  return float(h >> 8u)/16777215.0;
}
vec4 atlasNoiseGradient(vec3 p, vec3 invScale, uint seed) {
  vec3 q = p*invScale;
  ivec3 cell = ivec3(floor(q));
  vec3 f = q-vec3(cell);
  vec3 s = f*f*f*(f*(f*6.0-15.0)+10.0);
  vec3 ds = 30.0*f*f*(f-1.0)*(f-1.0);
  vec4 outValue = vec4(0.0);
  for (int x=0; x<2; x++) for (int y=0; y<2; y++) for (int z=0; z<2; z++) {
    vec3 c=vec3(float(x),float(y),float(z));
    vec3 w=mix(1.0-s,s,c), dw=mix(-ds,ds,c);
    float v=atlasLattice(cell+ivec3(x,y,z),seed);
    outValue.x += v*w.x*w.y*w.z;
    outValue.yzw += v*vec3(dw.x*w.y*w.z,w.x*dw.y*w.z,w.x*w.y*dw.z);
  }
  return vec4(outValue.x*2.0-1.0,outValue.yzw*(2.0*invScale));
}
float atlasAttenuation(float scaleMm,float footprintMm) {
  float t=clamp((footprintMm/scaleMm-0.35)/0.9,0.0,1.0);
  return 1.0-t*t*(3.0-2.0*t);
}
AtlasMaterialSample atlasSampleMaterial(vec3 restMm,float region,float footprintMm) {
  region=clamp(region,0.0,1.0);
  float scale=uAtlasMottleScaleMm, fine=uAtlasFineScaleMm;
  vec4 coarse=atlasNoiseGradient(restMm,vec3(1.0/scale),uAtlasSeed ^ 137u);
  vec4 meso=atlasNoiseGradient(restMm,vec3(1.0/(scale*0.24)),uAtlasSeed ^ 509u);
  vec4 grain=atlasNoiseGradient(restMm,vec3(1.0/fine),uAtlasSeed ^ 2017u);
  vec4 micro=atlasNoiseGradient(restMm,vec3(1.0/(fine*0.37)),uAtlasSeed ^ 7919u);
  vec4 structure=atlasNoiseGradient(restMm,uAtlasStructureStretch/uAtlasStructureScaleMm,uAtlasSeed ^ 3571u);
  if (uAtlasStructureMode==2) {
    structure.yzw *= 1.5-1.5*structure.x*structure.x;
    structure.x *= 1.5-0.5*structure.x*structure.x;
  }
  coarse *= atlasAttenuation(scale,footprintMm);
  meso *= atlasAttenuation(scale*0.24,footprintMm);
  grain *= atlasAttenuation(fine,footprintMm);
  micro *= atlasAttenuation(fine*0.37,footprintMm);
  structure *= atlasAttenuation(uAtlasStructureScaleMm/max(max(uAtlasStructureStretch.x,uAtlasStructureStretch.y),uAtlasStructureStretch.z),footprintMm);
  float attenuation=1.0-0.7*region;
  vec3 base=mix(uAtlasBaseColor,uAtlasLigamentColor,region);
  float field=0.56*coarse.x+0.30*meso.x+0.09*uAtlasFineDetail*grain.x+0.05*uAtlasStructureStrength*structure.x;
  AtlasMaterialSample result;
  result.colorLinear=clamp(base*(1.0+uAtlasPigmentAmplitude*uAtlasPigmentContrast*attenuation*field*vec3(1.0,0.82,0.70)),vec3(0.001),vec3(0.98));
  result.roughness=clamp(uAtlasRoughnessBase+0.13-0.26*uAtlasWetness+0.07*region+0.045*uAtlasFineDetail*grain.x+0.025*uAtlasPigmentContrast*meso.x,0.16,0.82);
  float amp=uAtlasHeightAmplitudeMm*uAtlasFineDetail*attenuation;
  result.heightMm=amp*(0.63*grain.x+0.25*micro.x+0.12*uAtlasStructureStrength*structure.x);
  result.heightGradientRest=amp*(0.63*grain.yzw+0.25*micro.yzw+0.12*uAtlasStructureStrength*structure.yzw);
  result.clearcoat=0.06+0.54*uAtlasWetness;
  result.clearcoatRoughness=0.48-0.30*uAtlasWetness;
  return result;
}
