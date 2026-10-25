import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { registerSceneRecordingSource } from "../sceneRecordingSource";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { TissueControls, TissueManifest } from "./contracts";
import { createLumenWalkthrough, surfaceGeometry } from "./geometry";
import { loadTissueMaps } from "./assets";
import { createTissueMaterial } from "./material";
import { createScopeLighting } from "./lighting";
import { loadOrganSurface, supportedOrganSurface, organOrbitPose, type OrganSurface } from "./organSurface";
import { bakeOrganMeshTextures, extractRgbaFromTexture, refineCoarseOrganGeometry, resolveBakeOrgan, type OrganMeshBakeResult } from "./organMeshBake";
import { createCapture, type TissueViewportHandle } from "./capture";
export type { TissueVideoResult, TissueViewportHandle } from "./capture";

export interface OrganBakeConfig { enabled: boolean; tileScaleMm?: number; blendSharpness?: number; atlasResolution?: number }
export interface TissueAppearance { seed?: string; region?: string; texture: THREE.Texture; condition: string; modelId: string; resolution: number; evidence: string }
interface Props { localFiles?: ReadonlyMap<string, Blob>; importedMaterial?: { bundleSha256: string; sourceFile: string; provenance: TissueManifest["provenance"] }; appearance?: TissueAppearance; organBakeConfig?: OrganBakeConfig; onOrganBaked?: (bake: OrganMeshBakeResult | undefined) => void; manifest: TissueManifest; directory: string; controls: TissueControls; onError: (message: string) => void }
const SPEED_MM_PER_SECOND = 18;

export const TissueViewport = forwardRef<TissueViewportHandle, Props>(function TissueViewport(props, ref) {
  const host = useRef<HTMLDivElement>(null), latest = useRef(props); latest.current = props;
  const runtime = useRef<(TissueViewportHandle & { update: () => void }) | null>(null);
  useImperativeHandle(ref, () => ({ capture: (w, h, time) => runtime.current?.capture(w, h, time) ?? "", record: (seconds, mime) => runtime.current ? runtime.current.record(seconds, mime) : Promise.reject(new Error("Material is still loading")) }), []);
  useEffect(() => {
    const element = host.current!, controller = new AbortController();
    delete element.dataset.tissueReady;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false }); }
    catch (error) { latest.current.onError(String(error)); return; }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    element.append(renderer.domElement);
    renderer.domElement.setAttribute("aria-label", "Layered tissue preview with surgical camera light");
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(58, 1, .3, 1200);
    const orbit = new OrbitControls(camera, renderer.domElement); orbit.enableDamping = true;
    const room = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(renderer), env = pmrem.fromScene(room, .1);
    room.dispose(); pmrem.dispose();
    const lighting = createScopeLighting(scene), group = new THREE.Group(); scene.add(group);
    let textureSet: Awaited<ReturnType<typeof loadTissueMaps>> | undefined;
    let materialSet: ReturnType<typeof createTissueMaterial> | undefined;
    let organSurface: OrganSurface | undefined, organLoading = false, organLoadFailed = false, organMaterialSet: ReturnType<typeof createTissueMaterial> | undefined;
    let organBakeResult: OrganMeshBakeResult | undefined, lastBakeKey = "";
    let oldYaw = NaN, oldPitch = NaN, preserveManualCapturePose = false;
    let geometry: THREE.BufferGeometry | undefined, path: ReturnType<typeof createLumenWalkthrough> | undefined;
    let disposed = false, frame = 0, last = 0, elapsed = latest.current.controls.time, oldView = "", oldSeed = -1, frameCount = 0;
    const timings: number[] = [];
    let lastTime = latest.current.controls.time;
    const draw = (time: number, forcePose = false) => {
      const control = latest.current.controls;
      if (control.view === "walkthrough" && path) {
        const pose = path.sampleCamera(time, SPEED_MM_PER_SECOND, { yawDeg: control.cameraYawDeg ?? 0, pitchDeg: control.cameraPitchDeg ?? 0 });
        camera.position.copy(pose.position); camera.up.copy(pose.up); camera.lookAt(pose.target);
      }
      if (control.view === "organ") {
        if (!organSurface) return;
        if (forcePose || control.playing || capture.recording) {
          const pose = organOrbitPose(organSurface, time, control.cameraYawDeg ?? 0, control.cameraPitchDeg ?? 0);
          camera.position.copy(pose.position); camera.up.copy(pose.up); camera.lookAt(pose.target); orbit.target.copy(pose.target);
        }
      }
      lighting.update(camera, control, orbit.target);
      renderer.render(scene, camera);
      element.dataset.tissueReady = "true";
    };
    const capture = createCapture(renderer, camera, time => draw(time, !preserveManualCapturePose), () => elapsed, () => latest.current.controls.view === "walkthrough" ? Boolean(path) : latest.current.controls.view === "organ" && Boolean(organSurface));
    const nativeRecording = registerSceneRecordingSource({ renderer, camera, host: element, label: "Tissue material scene", draw: () => draw(elapsed), available: () => Boolean(materialSet) && !capture.recording && (latest.current.controls.view !== "organ" || Boolean(organSurface)) });
    const update = () => {
      if (!materialSet) return;
      const control = latest.current.controls;
      materialSet.setSubstrate(latest.current.appearance?.texture);
      if (control.time !== lastTime) { elapsed = control.time; lastTime = control.time; }
      const targetOrgan = latest.current.organBakeConfig?.enabled
        ? (resolveBakeOrgan(props.manifest.recipe.organ) ?? props.manifest.recipe.organ)
        : props.manifest.recipe.organ;
      if (control.view === "organ" && !organSurface) {
        if (!supportedOrganSurface(targetOrgan)) { latest.current.onError("No atlas exterior is available for this material family"); return; }
        if (!organLoading) {
          if (organLoadFailed) { latest.current.onError(""); organLoadFailed = false; }
          organLoading = true; delete element.dataset.tissueReady; element.setAttribute("aria-busy", "true");
          void loadOrganSurface(targetOrgan, controller.signal).then(surface => {
            if (disposed) { surface.geometry.dispose(); return; }
            try { organMaterialSet = createTissueMaterial(textureSet!.maps, props.manifest, latest.current.controls, "triplanar"); }
            catch (error) { surface.geometry.dispose(); throw error; }
            organSurface = surface; organLoading = false;
            element.removeAttribute("aria-busy"); update();
          }).catch(error => {
            if (disposed) return;
            organLoading = false; organLoadFailed = true; element.removeAttribute("aria-busy");
            // A later explicit selection may retry; failure itself does not schedule update().
            if (latest.current.controls.view === "organ") latest.current.onError(String(error));
          });
        }
        return;
      }
      if (control.view === "organ" && organSurface && organMaterialSet && textureSet) {
        const bakeCfg = latest.current.organBakeConfig;
        const shouldBake = Boolean(bakeCfg?.enabled) || props.manifest.generator === "viscera.tissue-lora/v1";
        if (shouldBake) {
          const tileScaleMm = bakeCfg?.tileScaleMm ?? props.manifest.recipe.tile_size_mm;
          const blendSharpness = bakeCfg?.blendSharpness ?? 6;
          const atlasResolution = bakeCfg?.atlasResolution ?? 256;
          const sourceTexture = latest.current.appearance?.texture ?? textureSet.maps.substrate;
          // Same model/seed can produce a different image after changing condition,
          // resolution or weights. Cache the texture actually consumed by the bake.
          const nextBakeKey = `${targetOrgan}:${sourceTexture.uuid}:${sourceTexture.version}:${atlasResolution}:${tileScaleMm}:${blendSharpness}:${control.wetness}`;
          if (nextBakeKey !== lastBakeKey || !organBakeResult) {
            organBakeResult?.dispose();
            const maxAniso = renderer.capabilities.getMaxAnisotropy();
            organBakeResult = bakeOrganMeshTextures(
              targetOrgan,
              organSurface,
              { substrate: extractRgbaFromTexture(sourceTexture) },
              { atlasResolution, tileScaleMm, blendSharpness, variancePreserving: true, wetness: control.wetness },
            );
            organBakeResult.seamlessTileTexture.anisotropy = maxAniso;
            organBakeResult.seamlessNormalTexture.anisotropy = maxAniso;
            organBakeResult.seamlessRoughnessTexture.anisotropy = maxAniso;
            lastBakeKey = nextBakeKey;
            latest.current.onOrganBaked?.(organBakeResult);
          }
          organMaterialSet.setOrganBake({
            substrate: organBakeResult.seamlessTileTexture,
            normal: organBakeResult.seamlessNormalTexture,
            roughness: organBakeResult.seamlessRoughnessTexture,
            tileScaleMm,
            blendSharpness,
            meanLinear: organBakeResult.metrics.meanColorLinear,
          }, latest.current.appearance?.texture);
        } else {
          if (organBakeResult) {
            organBakeResult.dispose();
            organBakeResult = undefined;
            lastBakeKey = "";
            latest.current.onOrganBaked?.(undefined);
          }
          organMaterialSet.setOrganBake(undefined, latest.current.appearance?.texture);
        }
      } else {
        organMaterialSet?.setOrganBake(undefined, latest.current.appearance?.texture);
      }
      const material = (control.view === "organ" ? organMaterialSet! : materialSet).update(control);
      const directionChanged = oldYaw !== (control.cameraYawDeg ?? 0) || oldPitch !== (control.cameraPitchDeg ?? 0);
      const viewChanged = oldView !== control.view || oldSeed !== control.seed;
      if (viewChanged) {
        group.clear(); geometry?.dispose(); path = undefined;
        if (control.view === "walkthrough") {
          const organ = props.manifest.recipe.organ;
          path = createLumenWalkthrough(control.seed, { profile: organ === "gastric_mucosa" ? "gastric" : organ === "intestinal_mucosa" ? "small-bowel" : "colon", tileSizeMm: props.manifest.recipe.tile_size_mm });
          geometry = path.geometry;
        } else if (control.view === "organ") {
          geometry = refineCoarseOrganGeometry(organSurface!.geometry);
        } else geometry = surfaceGeometry();
        const mesh = new THREE.Mesh(geometry, material); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
        oldView = control.view; oldSeed = control.seed;
        if (control.view === "surface") { orbit.minDistance = 10; orbit.maxDistance = 500; camera.up.set(0, 1, 0); camera.position.set(3, -30, 100); orbit.target.set(0, 0, 0); orbit.update(); }
      }
      group.children.forEach(child => { (child as THREE.Mesh).material = material; });
      if (control.view === "organ" && (viewChanged || directionChanged)) {
        const pose = organOrbitPose(organSurface!, elapsed, control.cameraYawDeg ?? 0, control.cameraPitchDeg ?? 0);
        camera.position.copy(pose.position); camera.up.copy(pose.up); orbit.target.copy(pose.target);
        orbit.minDistance = organSurface!.radius * 1.12; orbit.maxDistance = organSurface!.radius * 8; orbit.update();
      }
      oldYaw = control.cameraYawDeg ?? 0; oldPitch = control.cameraPitchDeg ?? 0;
      const inside = control.view === "walkthrough";
      orbit.enabled = !inside && !control.playing && !capture.recording; scene.environment = control.view === "surface" ? env.texture : null; scene.environmentIntensity = .18;
      orbit.enablePan = control.view === "surface";
      camera.far = control.view === "organ" ? Math.max(1200, organSurface!.radius * 12) : 1200;
      camera.fov = inside ? 92 : 58; camera.updateProjectionMatrix();
      renderer.toneMappingExposure = inside && props.manifest.recipe.organ === "gastric_mucosa" ? 1.5 : 1;
      renderer.setClearColor(inside ? 0x120504 : 0x100d10);
      // Air-filled inspection phantom: no invented volumetric fog.
      scene.fog = null;
      const appearance = latest.current.appearance;
      element.dataset.tissueSnapshot = JSON.stringify({ organ: props.manifest.recipe.organ, resolution: props.manifest.resolution, ...control, geometry: inside ? "curved-lumen-phantom-v3" : control.view === "organ" ? "source-atlas-exterior-v1" : "80-mm-surface-coupon", temporalBinding: control.view === "organ" ? "object-mm-triplanar" : "fixed-rest-uv", importedMaterial: latest.current.importedMaterial ?? null, atlas: control.view === "organ" ? { ...organSurface!.provenance, nodes: organSurface!.nodes, projection: "surface-gradient triplanar; assumed atlas mm", orbitPeriodSeconds: 24 } : null, organBake: control.view === "organ" && organBakeResult ? { ...organBakeResult.metrics, source: appearance ? { kind: "generated-appearance", modelId: appearance.modelId, seed: appearance.seed, condition: appearance.condition, resolution: appearance.resolution } : { kind: props.manifest.generator === "viscera.tissue-lora/v1" ? "learned-tile" : "material", directory: props.directory, substrateSha256: props.manifest.channels.substrate?.sha256, seed: props.manifest.recipe.seed } } : null, materialRevision: "spatial-film-v4-wet-interface-ablation-v1-material-variation-v1", editableRelief: Boolean(props.manifest.channels.layer_relief), opticsRevision: "camera-rig-cavity-fill-v3", indirectLight: "authored constant cavity fill; not measured scattering", appearance: appearance ? { seed: appearance.seed, region: appearance.region, condition: appearance.condition, modelId: appearance.modelId, resolution: appearance.resolution, evidence: appearance.evidence } : null, exposure: renderer.toneMappingExposure, trajectory: path ? { lengthMm: path.lengthMm, speedMmPerSecond: SPEED_MM_PER_SECOND, periodSeconds: path.lengthMm / SPEED_MM_PER_SECOND } : null });
    };
    const resize = () => { if (capture.recording || nativeRecording.active) return; renderer.setSize(element.clientWidth, element.clientHeight); camera.aspect = element.clientWidth / Math.max(1, element.clientHeight); camera.updateProjectionMatrix(); };
    const captureFrame: TissueViewportHandle["capture"] = (...args) => {
      if (nativeRecording.active) throw new Error("Stop scene recording before saving a still image.");
      if (latest.current.controls.view === "organ" && !organSurface) throw new Error("Atlas surface is still loading");
      const position = camera.position.clone(), quaternion = camera.quaternion.clone(), up = camera.up.clone(), target = orbit.target.clone();
      // Save the user's manual exterior viewpoint unless an explicit deterministic time is requested.
      preserveManualCapturePose = latest.current.controls.view === "organ" && !latest.current.controls.playing && args[2] === undefined;
      try { return capture.capture(...args); }
      finally {
        preserveManualCapturePose = false;
        // Fixed-time atlas captures follow the documented orbit; restore manual inspection.
        if (latest.current.controls.view === "organ" && !latest.current.controls.playing) {
          camera.position.copy(position); camera.quaternion.copy(quaternion); camera.up.copy(up); orbit.target.copy(target); draw(elapsed);
        }
      }
    };
    const record: TissueViewportHandle["record"] = async (...args) => {
      if (nativeRecording.active) throw new Error("A scene recording is already in progress.");
      const materialSnapshot = JSON.parse(element.dataset.tissueSnapshot ?? "{}");
      try { const result = await capture.record(...args); return { ...result, metrics: { ...result.metrics, materialSnapshot } }; }
      finally { if (!disposed) { resize(); draw(elapsed); } }
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const animate = (now: number) => {
      orbit.enabled = latest.current.controls.view !== "walkthrough" && !latest.current.controls.playing && !capture.recording;
      if (last) {
        const delta = now - last;
        if (latest.current.controls.playing || capture.recording) elapsed += delta / 1000;
        capture.sampleFrame(delta); timings.push(delta); if (timings.length > 240) timings.shift();
      }
      last = now; if (orbit.enabled) orbit.update(); draw(elapsed);
      if (++frameCount % 30 === 0) {
        const sorted = [...timings].sort((a, b) => a - b);
        element.dataset.frameTiming = JSON.stringify({ frames: timings.length, medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0, p95Ms: sorted[Math.floor(sorted.length * .95)] ?? 0, width: renderer.domElement.width, height: renderer.domElement.height });
        element.dataset.tissueResources = JSON.stringify({ geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs?.length ?? 0, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles });
      }
      frame = requestAnimationFrame(animate);
    };
    void loadTissueMaps(props.manifest, props.directory, renderer.capabilities.getMaxAnisotropy(), controller.signal, undefined, props.localFiles).then(loaded => {
      if (disposed) { loaded.dispose(); return; }
      textureSet = loaded; materialSet = createTissueMaterial(loaded.maps, props.manifest, latest.current.controls);
      update(); frame = requestAnimationFrame(animate);
      runtime.current = { update, capture: captureFrame, record };
      // Read-only render hooks for deterministic still/video acceptance.
      Object.assign(element, { captureTissueFrame: captureFrame, recordTissueVideo: record });
    }).catch(error => { if (!disposed) latest.current.onError(String(error)); });
    const contextLost = (event: Event) => { event.preventDefault(); latest.current.onError("GPU context lost. Select preview maps and reload."); };
    renderer.domElement.addEventListener("webglcontextlost", contextLost);
    return () => {
      disposed = true; nativeRecording.dispose(); controller.abort(); capture.dispose(); cancelAnimationFrame(frame); observer.disconnect(); orbit.dispose();
      latest.current.onOrganBaked?.(undefined);
      geometry?.dispose(); organBakeResult?.dispose(); organSurface?.geometry.dispose(); organMaterialSet?.dispose(); materialSet?.dispose(); textureSet?.dispose(); lighting.dispose(); env.dispose();
      renderer.domElement.removeEventListener("webglcontextlost", contextLost); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); runtime.current = null;
      delete (element as HTMLDivElement & { captureTissueFrame?: unknown }).captureTissueFrame;
      delete (element as HTMLDivElement & { recordTissueVideo?: unknown }).recordTissueVideo;
      delete element.dataset.tissueReady;
    };
  }, [props.directory, props.manifest, props.localFiles]);
  useEffect(() => runtime.current?.update(), [props.controls, props.appearance, props.importedMaterial, props.organBakeConfig]);
  return <div className="tissue-viewport" ref={host} />;
});
