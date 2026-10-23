import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { registerSceneRecordingSource } from "../sceneRecordingSource";

interface Props {
  onError: (message: string) => void;
}

const SOURCE = Object.freeze({
  title: "HRA female omentum v1.0",
  creator: "Heidi Schlehlein",
  year: 2026,
  doi: "https://doi.org/10.48539/HBM636.GWRW.698",
  license: "CC BY 4.0",
  sha256: "692622d5ab89014630ea6952dcb9849bb5c4ad6243d1792e2cb3efe94ef42d98",
});

function disposeTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) textures.add(value);
      }
    }
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
  textures.forEach(texture => texture.dispose());
}

/** Unchanged source geometry, recentered and displayed in neutral clay.
 * This source is an atlas illustration, not a surgical scan or generated fat.
 */
export function FatReferenceViewport({ onError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const reportError = useRef(onError);
  reportError.current = onError;

  useEffect(() => {
    const element = host.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (error) {
      reportError.current(`The anatomical reference viewer could not start: ${String(error)}`);
      return;
    }

    let disposed = false;
    let animation = 0;
    let dirty = true;
    let reference: THREE.Object3D | null = null;
    element.dataset.referenceReady = "false";
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.setClearColor(0x10171d, 0);
    const canvas = renderer.domElement;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Human Reference Atlas female omentum. Neutral clay display of original atlas geometry; drag to orbit, scroll to zoom.");
    element.appendChild(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.minDistance = 60;
    controls.maxDistance = 1800;
    camera.position.set(280, 170, 500);

    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromScene(room, 0.05);
    room.dispose();
    pmrem.dispose();
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.4;
    scene.add(new THREE.HemisphereLight(0xf4f4ee, 0x4b4137, 1.1));
    const key = new THREE.DirectionalLight(0xfff3de, 3);
    key.position.set(-250, 300, 450);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xd7e7fa, 1.1);
    fill.position.set(350, 100, -180);
    scene.add(fill);

    const markDirty = () => { dirty = true; };
    controls.addEventListener("change", markDirty);
    let extent = 250;
    const fit = () => {
      const verticalDistance = extent / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
      const distance = verticalDistance * Math.max(1, 1 / camera.aspect) * 1.3;
      camera.position.copy(new THREE.Vector3(0.35, 0.25, 1).normalize().multiplyScalar(distance));
      controls.target.set(0, 0, 0);
      camera.lookAt(controls.target);
      controls.update();
      dirty = true;
    };
    const nativeRecording = registerSceneRecordingSource({ renderer, camera, host: element, label: "HRA omentum reference", draw: () => renderer.render(scene, camera), available: () => Boolean(reference) });
    const resize = () => {
      if (nativeRecording.active) return;
      const width = Math.max(1, element.clientWidth);
      const height = Math.max(1, element.clientHeight);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      dirty = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    fit();
    const animate = () => {
      if (disposed) return;
      controls.update();
      if (dirty || nativeRecording.active) {
        renderer.render(scene, camera);
        if (reference) element.dataset.referenceReady = "true";
        dirty = false;
      }
      animation = requestAnimationFrame(animate);
    };
    animation = requestAnimationFrame(animate);

    const contextLost = (event: Event) => {
      event.preventDefault();
      element.dataset.referenceReady = "false";
      reportError.current("The anatomical reference GPU context was lost. Reopen the reference viewer.");
    };
    canvas.addEventListener("webglcontextlost", contextLost);

    const sourceUrl = `${import.meta.env.BASE_URL}fat-lab/reference-omentum.glb`;
    void new GLTFLoader().loadAsync(sourceUrl).then(gltf => {
      if (disposed) {
        disposeTree(gltf.scene);
        return;
      }
      const originalBounds = new THREE.Box3().setFromObject(gltf.scene);
      if (originalBounds.isEmpty()) {
        disposeTree(gltf.scene);
        throw new Error("The reference contains no displayable geometry.");
      }
      const centre = originalBounds.getCenter(new THREE.Vector3());
      const dimensionsMm = originalBounds.getSize(new THREE.Vector3()).multiplyScalar(1000);
      const clay = new THREE.MeshStandardMaterial({ color: 0xc7bea8, roughness: 0.66, metalness: 0, side: THREE.DoubleSide });
      clay.name = "Reference viewer neutral clay; original anatomy unchanged";
      const originalMaterials = new Set<THREE.Material>();
      const originalTextures = new Set<THREE.Texture>();
      let triangles = 0;
      let vertices = 0;
      gltf.scene.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        vertices += object.geometry.getAttribute("position").count;
        triangles += (object.geometry.index?.count ?? object.geometry.getAttribute("position").count) / 3;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
          originalMaterials.add(material);
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) originalTextures.add(value);
        }
        object.material = clay;
      });
      originalMaterials.forEach(material => material.dispose());
      originalTextures.forEach(texture => texture.dispose());
      // glTF source coordinates are metres. Retain every internal source transform.
      gltf.scene.position.sub(centre);
      const millimetres = new THREE.Group();
      millimetres.scale.setScalar(1000);
      millimetres.add(gltf.scene);
      reference = millimetres;
      scene.add(reference);
      extent = Math.max(dimensionsMm.x, dimensionsMm.y, dimensionsMm.z);
      element.dataset.referenceMetadata = JSON.stringify({
        source: SOURCE,
        originalBoundsM: { min: originalBounds.min.toArray(), max: originalBounds.max.toArray() },
        dimensionsMm: dimensionsMm.toArray(), vertices, triangles,
        displayUnits: "millimetres", displayMaterial: "neutral clay", originalTextureCount: 0,
        role: "anatomical atlas reference; not a surgical scan or calibrated simulation",
      });
      fit();
    }).catch(error => {
      if (!disposed) reportError.current(`Could not load the HRA omentum reference: ${String(error)}`);
    });

    return () => {
      disposed = true; nativeRecording.dispose();
      cancelAnimationFrame(animation);
      observer.disconnect();
      controls.removeEventListener("change", markDirty);
      controls.dispose();
      canvas.removeEventListener("webglcontextlost", contextLost);
      if (reference) disposeTree(reference);
      environment.dispose();
      renderer.dispose();
      canvas.remove();
      delete element.dataset.referenceReady;
      delete element.dataset.referenceMetadata;
    };
  }, []);

  return <div className="fat-viewport" ref={host}>
    <div style={{ position: "absolute", left: 24, bottom: 70, zIndex: 1, maxWidth: 440, color: "#c7c8c4", fontSize: 12, lineHeight: 1.55, pointerEvents: "none" }}>
      HRA female omentum · original atlas geometry in neutral clay<br />
      Heidi Schlehlein, 2026 · CC BY 4.0 · not a surgical scan
    </div>
  </div>;
}
