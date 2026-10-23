import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { registerSceneRecordingSource } from "../sceneRecordingSource";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { createFatMaterial, updateFatOptics, FAT_MATERIAL_VERSION, type FatMaps, type FatSurfaceStudy } from "./material";
import type { FatGeometryData } from "./generator";

export type FatLighting = "studio" | "surgical" | "grazing" | "backlight" | "dark";
export interface FatViewportHandle { capture: () => string; exportGeometry: () => Promise<ArrayBuffer>; fit: () => void }
interface Props {
  study: FatSurfaceStudy; lighting: FatLighting; specimen: FatGeometryData; maps: FatMaps | null; wetness: number; scattering: number; shadows: boolean; lightOrbit: boolean; rotate: boolean;
  deformation: { x: number; y: number; z: number }; onError: (message: string) => void;
}
export function fatBufferGeometry(data: FatGeometryData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(data.positions.slice(), 3));
  geometry.setAttribute("fatRestPosition", new THREE.BufferAttribute(data.positions.slice(), 3));
  geometry.setAttribute("fatRestNormal", new THREE.BufferAttribute(data.normals.slice(), 3));
  geometry.setAttribute("fatThicknessMm", new THREE.BufferAttribute(data.thicknessMm, 1));
  geometry.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  return geometry;
}
export const FatViewport = forwardRef<FatViewportHandle, Props>(function FatViewport(props, ref) {
  const host = useRef<HTMLDivElement>(null), latest = useRef(props); latest.current = props;
  const runtime = useRef<{ update: () => void; capture: () => string; exportGeometry: () => Promise<ArrayBuffer>; fit: () => void } | null>(null);
  useImperativeHandle(ref, () => ({ capture: () => runtime.current?.capture() ?? "", fit: () => runtime.current?.fit(),
    exportGeometry: () => runtime.current ? runtime.current.exportGeometry() : Promise.reject(new Error("The specimen is still loading.")) }), []);
  useEffect(() => {
    const element = host.current!;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false }); }
    catch (error) { latest.current.onError(String(error)); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .88;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x182127, 1);
    const canvas = renderer.domElement; canvas.setAttribute("aria-label", "Generated adipose specimen. Drag to orbit; scroll to zoom."); canvas.setAttribute("role", "img"); element.append(canvas);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(34, 1, .1, 3000);
    const controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.autoRotateSpeed = .65;
    const room = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(renderer), env = pmrem.fromScene(room, .08);
    room.dispose(); pmrem.dispose(); scene.environment = env.texture; scene.environmentIntensity = .3;
    const hemisphere = new THREE.HemisphereLight(0xe8edf4, 0x3a2919, .4); scene.add(hemisphere);
    const key = new THREE.DirectionalLight(0xffead3, 1.8); key.position.set(-100, 160, 100); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left:-150,right:150,top:150,bottom:-150,near:1,far:600 }); key.shadow.normalBias = .35; key.shadow.bias = -.0003; scene.add(key);
    const fill = new THREE.DirectionalLight(0xe8f1ff, .5); fill.position.set(140, 60, -90); scene.add(fill);
    const cameraLamp = new THREE.SpotLight(0xffffff, 120000, 0, .65, .65, 2); cameraLamp.castShadow=true; cameraLamp.shadow.mapSize.set(2048,2048); cameraLamp.shadow.camera.near=10; cameraLamp.shadow.camera.far=1000; cameraLamp.shadow.normalBias=.35; cameraLamp.shadow.bias=-.0003; scene.add(cameraLamp, cameraLamp.target);
    const mesh = new THREE.Mesh(fatBufferGeometry(latest.current.specimen), new THREE.MeshPhysicalMaterial({ color:0xe3b75d, roughness:.4 })); mesh.castShadow = true; mesh.receiveShadow = false; scene.add(mesh);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(900,900), new THREE.ShadowMaterial({ opacity:.18 })); ground.rotation.x=-Math.PI/2; ground.receiveShadow=true; scene.add(ground);
    const scaleLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-25,0,0),new THREE.Vector3(25,0,0)]),new THREE.LineBasicMaterial({color:0x82969b})); scene.add(scaleLine);
    let lightPhase=0, lastFrameTime=performance.now();
    let revision = 0, frame = 0, dirty = true, oldSpecimen: FatGeometryData | null = null, oldMaps: FatMaps | null = null, oldWetness = -1, oldStudy: FatSurfaceStudy | null = null;
    const fit = () => { const dims=latest.current.specimen.stats.dimensionsMm; const r=Math.max(...dims); controls.target.set(0,0,0); camera.position.set(r*.95,r*.8,r*1.5); camera.lookAt(controls.target); controls.update(); dirty=true; };
    const update = () => {
      const next = latest.current;
      const resized = !oldSpecimen || oldSpecimen.stats.dimensionsMm.some((value, i) => value !== next.specimen.stats.dimensionsMm[i]);
      if (next.specimen !== oldSpecimen) { mesh.geometry.dispose(); mesh.geometry=fatBufferGeometry(next.specimen); oldSpecimen=next.specimen; }
      if (next.maps !== oldMaps || next.wetness !== oldWetness || next.study !== oldStudy) {
        mesh.material.dispose(); mesh.material=next.maps ? createFatMaterial(next.maps,next.wetness,undefined,next.study) : new THREE.MeshPhysicalMaterial({color:0xe3b75d,roughness:.4}); oldMaps=next.maps; oldWetness=next.wetness; oldStudy=next.study;
      }
      const surgical = next.lighting === "surgical", grazing = next.lighting === "grazing", backlight = next.lighting === "backlight", dark = next.lighting === "dark";
      key.position.set(grazing ? -180 : -100, grazing ? 15 : 160, grazing ? 30 : 100);
      key.intensity = surgical || dark ? 0 : backlight ? 4 : grazing ? 2.2 : 1.8;
      cameraLamp.intensity = surgical ? 120000 : 0;
      // Inactive lights must leave the shadow pass too: ShadowMaterial multiplies
      // shadow masks even when a light intensity is zero.
      cameraLamp.visible = surgical; key.visible = !surgical && !dark;
      fill.intensity = dark ? 0 : surgical ? .08 : backlight ? .02 : grazing ? .18 : .5;
      hemisphere.intensity = dark ? 0 : surgical ? .1 : backlight ? .02 : grazing ? .18 : .4;
      scene.environmentIntensity = dark ? 0 : surgical ? .08 : backlight ? .015 : grazing ? .15 : .3;
      // Low-angle shadows extend outside the finite presentation floor/frustum.
      // The floor is a studio aid, so omit it in those optical diagnostics.
      ground.visible = !grazing && !backlight && !dark;
      mesh.receiveShadow = next.shadows && !backlight;
      updateFatOptics(mesh.material, next.scattering, next.deformation.y);
      mesh.scale.set(next.deformation.x,next.deformation.y,next.deformation.z);
      ground.position.y = -next.specimen.stats.dimensionsMm[1]*next.deformation.y/2-.4;
      scaleLine.position.set(0,ground.position.y+.3,next.specimen.stats.dimensionsMm[2]*.75);
      if (resized) fit();
      dirty=true; revision++;
      element.dataset.fatSnapshot=JSON.stringify({revision,stats:next.specimen.stats,textureResolution:next.maps?.resolution ?? 0,deformation:next.deformation,material:FAT_MATERIAL_VERSION,scaleBarMm:50,study:next.study,lighting:next.lighting,scattering:next.scattering,selfShadows:next.shadows&&!backlight,lightOrbit:next.lightOrbit,rendering:{textures:renderer.info.memory.textures,geometries:renderer.info.memory.geometries,background:"opaque #182127",cameraLight:"inverse-square spotlight in millimetre scene units"}});
    };
    const draw = () => { if(latest.current.lighting === "surgical") {cameraLamp.position.copy(camera.position);cameraLamp.target.position.copy(controls.target);} if(latest.current.lighting === "backlight")key.position.copy(camera.position).multiplyScalar(-1); if(latest.current.lightOrbit && (latest.current.lighting==="studio"||latest.current.lighting==="grazing"))key.position.set(Math.cos(lightPhase)*180,latest.current.lighting==="grazing"?15:100,Math.sin(lightPhase)*180); renderer.render(scene,camera); element.dataset.fatReady="true"; element.dataset.fatRuntime=JSON.stringify({textures:renderer.info.memory.textures,geometries:renderer.info.memory.geometries,programs:renderer.info.programs?.length,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles}); dirty=false; };
    const nativeRecording = registerSceneRecordingSource({ renderer, camera, host: element, label: "Fat specimen", draw, available: () => Boolean(oldSpecimen) });
    const change = () => { dirty=true; }; controls.addEventListener("change",change);
    const resize = () => { if (nativeRecording.active) return; const w=Math.max(1,element.clientWidth),h=Math.max(1,element.clientHeight); renderer.setSize(w,h); camera.aspect=w/h; camera.updateProjectionMatrix(); dirty=true; };
    const observer = new ResizeObserver(resize); observer.observe(element); resize(); fit(); update();
    const animate = (now:number) => {const dt=Math.min(.1,Math.max(0,(now-lastFrameTime)/1000));lastFrameTime=now;if(latest.current.lightOrbit)lightPhase+=dt*.45; controls.autoRotate=latest.current.rotate; controls.update(); if(dirty||nativeRecording.active||controls.autoRotate||latest.current.lightOrbit)draw(); frame=requestAnimationFrame(animate); }; frame=requestAnimationFrame(animate);
    const lost = (event: Event) => { event.preventDefault(); latest.current.onError("The GPU context was lost. Reload the lab or select a smaller texture resolution."); }; canvas.addEventListener("webglcontextlost",lost);
    runtime.current = { update,fit,
      capture: () => { if (nativeRecording.active) { latest.current.onError("Stop scene recording before saving a still image."); return ""; } const size=renderer.getSize(new THREE.Vector2()),ratio=renderer.getPixelRatio(); const scale=Math.min(4096,renderer.capabilities.maxTextureSize)/Math.max(size.x,size.y); try { renderer.setPixelRatio(1); renderer.setSize(Math.round(size.x*scale),Math.round(size.y*scale),false); draw(); return canvas.toDataURL("image/png"); } finally { renderer.setPixelRatio(ratio);renderer.setSize(size.x,size.y,false);draw(); } },
      exportGeometry: async () => { const geometry=mesh.geometry.clone(); geometry.scale(.001,.001,.001); geometry.deleteAttribute("fatRestPosition"); geometry.deleteAttribute("fatRestNormal"); geometry.deleteAttribute("fatThicknessMm"); const material=new THREE.MeshStandardMaterial({color:0xe6bc72,roughness:.45}); const exported=new THREE.Mesh(geometry,material); exported.userData={generator:latest.current.specimen.stats.generatorVersion,units:"metres",specimen:latest.current.specimen.stats,note:"Rest geometry. Triplanar material is viewer-only; export maps and recipe separately."}; try { return await new GLTFExporter().parseAsync(exported,{binary:true}) as ArrayBuffer; } finally { geometry.dispose();material.dispose(); } },
    };
    return () => { nativeRecording.dispose(); cancelAnimationFrame(frame); observer.disconnect();controls.removeEventListener("change",change);controls.dispose();canvas.removeEventListener("webglcontextlost",lost);mesh.geometry.dispose();mesh.material.dispose();ground.geometry.dispose();ground.material.dispose();scaleLine.geometry.dispose();(scaleLine.material as THREE.Material).dispose();env.dispose();key.shadow.dispose();cameraLamp.shadow.dispose();renderer.dispose();canvas.remove();runtime.current=null; };
  },[]);
  useEffect(()=>runtime.current?.update(),[props.specimen,props.maps,props.wetness,props.deformation,props.study,props.lighting,props.scattering,props.shadows,props.lightOrbit]);
  return <div className="fat-viewport" ref={host}/>;
});
