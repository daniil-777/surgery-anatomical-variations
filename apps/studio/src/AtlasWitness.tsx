/** Development-only, standalone report harness. It deliberately reuses the
 * Studio viewport instead of approximating its rendering in a second engine. */
import { apiUrl } from "./api";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AtlasViewport, ATLAS_RENDER_VERSION, type AtlasMeshStats, type AtlasView, type AtlasViewportHandle } from "./AtlasViewport";
import type { AtlasGeneration, AtlasSpec } from "./atlas";
import { atlasError } from "./atlas";
import { validateScene } from "./project";
import { readAtlasMaterial } from "./atlasMaterialShader";

const poses: AtlasView[] = ["oblique", "back", "top"];
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function float32Hash(values: number[]) {
  const bytes = new ArrayBuffer(values.length * 4);
  const packed = new DataView(bytes);
  for (let i = 0; i < values.length; i++) packed.setFloat32(i * 4, values[i]!, true);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (value) => value.toString(16).padStart(2, "0")).join("");
}
function resizeSurface(width: number, height: number) {
  for (const element of [document.documentElement, document.body, document.getElementById("root"), document.querySelector<HTMLElement>(".atlas-viewport-canvas")]) {
    if (element) { element.style.width = `${width}px`; element.style.height = `${height}px`; }
  }
}
interface WitnessResult {
  png: string;
  renderer_version: string;
  geometry_sha256: unknown;
  scene_payload_geometry_sha256: string;
  max_gpu_coordinate_rounding_mm: number;
  display_normals: unknown;
  scene_payload_normal_sha256: string;
  scene_payload_srgb_color_sha256: string;
  realized_id: unknown;
  source: unknown;
  appearance: unknown;
  material_v2?: unknown;
  normal_repair?: unknown;
  spec: AtlasSpec;
  stats: AtlasMeshStats;
  views: Record<string, unknown>[];
}
declare global {
  interface Window {
    atlasWitness?: {
      version: string;
      render: (spec: AtlasSpec, expectedGeometrySha256: string) => Promise<WitnessResult>;
      captureHero: (pose: AtlasView, width: number, height: number) => Promise<{ png: string; view: Record<string, unknown> }>;
    };
  }
}

function pixelAudit(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext("webgl2");
  if (!gl) throw new Error("Witness WebGL2 context is unavailable");
  const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let occupied = 0, minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3]! <= 127) continue;
    occupied++; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (occupied < 40) throw new Error(`Empty witness: only ${occupied} opaque pixels`);
  if (minX <= 0 || minY <= 0 || maxX >= width - 1 || maxY >= height - 1)
    throw new Error(`Witness geometry touches the frame boundary: ${[minX, minY, maxX, maxY].join(",")}`);
  return { width, height, opaque_pixels: occupied, occupied_fraction: occupied / (width * height), bounds_bottom_origin: [minX, minY, maxX, maxY] };
}

function Witness() {
  const viewport = useRef<AtlasViewportHandle>(null);
  const [generation, setGeneration] = useState<AtlasGeneration | null>(null);
  const ready = useRef<((stats: AtlasMeshStats) => void) | null>(null);
  const failure = useRef("");
  const running = useRef(false);
  useEffect(() => {
    window.atlasWitness = {
      version: ATLAS_RENDER_VERSION,
      render: async (spec, expectedGeometrySha256) => {
        if (running.current) throw new Error("Witness jobs must run sequentially");
        running.current = true;
        failure.current = "";
        try {
          resizeSurface(256, 256);
          await frame();
          const response = await fetch(apiUrl("/api/atlas/generate"), {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec),
          });
          if (!response.ok) throw await atlasError(response);
          const result = await response.json() as AtlasGeneration;
          validateScene(result.scene);
          if (result.spec.material) for (const mesh of result.scene.organs) readAtlasMaterial(mesh, result.scene, result.spec.material);
          const geometryHash = result.scene.metadata?.geometry_sha256;
          if (geometryHash !== expectedGeometrySha256)
            throw new Error(`Geometry identity mismatch: expected ${expectedGeometrySha256}, received ${String(geometryHash)}`);
          if (result.scene.organs.length !== 1 || result.scene.vessels?.length)
            throw new Error("Witness geometry hash contract requires one packed reference surface");
          // Recompute the hash from the actual response arrays, not just the
          // server's claimed metadata. Match Python <f8 vertices + <i8 faces.
          const mesh = result.scene.organs[0]!;
          const geometryBytes = new ArrayBuffer((mesh.positions.length + mesh.indices.length) * 8);
          const packed = new DataView(geometryBytes);
          let maxRounding = 0;
          for (let i = 0; i < mesh.positions.length; i++) {
            const value = mesh.positions[i]!;
            packed.setFloat64(i * 8, value, true);
            maxRounding = Math.max(maxRounding, Math.abs(value - Math.fround(value)));
          }
          for (let i = 0; i < mesh.indices.length; i++) {
            if (mesh.indices[i]! > 4294967295) throw new Error("Witness face index exceeds the supported GPU range");
            packed.setUint32((mesh.positions.length + i) * 8, mesh.indices[i]!, true);
          }
          const actualGeometryHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", geometryBytes)), (value) => value.toString(16).padStart(2, "0")).join("");
          if (actualGeometryHash !== expectedGeometrySha256)
            throw new Error(`Scene payload identity mismatch: expected ${expectedGeometrySha256}, received ${actualGeometryHash}`);
          if (!mesh.normals || !mesh.colors) throw new Error("Witness requires explicit realized normals and colors");
          const normalHash = await float32Hash(mesh.normals);
          const colorHash = await float32Hash(mesh.colors);
          const normalPolicy = result.scene.metadata?.display_normals as Record<string, unknown> | undefined;
          if (!normalPolicy || normalPolicy.sha256 !== normalHash || normalPolicy.geometry_modified !== false)
            throw new Error("Display-normal metadata does not match the actual Float32 render attributes");
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stats = await new Promise<AtlasMeshStats>((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Witness scene did not mount within 60 seconds")), 60000);
            ready.current = resolve;
            setGeneration(result);
          }).finally(() => { if (timer) clearTimeout(timer); ready.current = null; });
          await frame();
          if (failure.current) throw new Error(failure.current);
          const canvas = document.querySelector<HTMLCanvasElement>(".atlas-viewport-canvas canvas");
          if (!canvas) throw new Error("Witness renderer has no canvas");
          const sheet = document.createElement("canvas"); sheet.width = 768; sheet.height = 256;
          const context = sheet.getContext("2d")!;
          const views: Record<string, unknown>[] = [];
          for (const [index, pose] of poses.entries()) {
            viewport.current!.view(pose);
            await frame();
            const audit = pixelAudit(canvas);
            const gradient = context.createRadialGradient(index * 256 + 128, 128, 0, index * 256 + 128, 128, 181);
            gradient.addColorStop(0, "#2b3035"); gradient.addColorStop(0.47, "#181e26"); gradient.addColorStop(1, "#111720");
            context.fillStyle = gradient; context.fillRect(index * 256, 0, 256, 256);
            context.drawImage(canvas, index * 256, 0, 256, 256);
            views.push({ pose, ...audit, ...viewport.current!.captureMetadata() });
          }
          return {
            png: sheet.toDataURL("image/png"), renderer_version: String(viewport.current!.captureMetadata().renderer_version ?? ATLAS_RENDER_VERSION),
            geometry_sha256: geometryHash, realized_id: result.scene.metadata?.realized_id,
            scene_payload_geometry_sha256: actualGeometryHash,
            max_gpu_coordinate_rounding_mm: maxRounding,
            display_normals: normalPolicy,
            scene_payload_normal_sha256: normalHash,
            scene_payload_srgb_color_sha256: colorHash,
            source: result.scene.metadata?.source, appearance: result.scene.metadata?.appearance,
            ...(result.scene.metadata?.material_v2 ? { material_v2: result.scene.metadata.material_v2 } : {}),
            ...(result.scene.metadata?.normal_repair ? { normal_repair: result.scene.metadata.normal_repair } : {}),
            spec: result.spec, stats, views,
          };
        } finally { running.current = false; }
      },
      captureHero: async (pose, width, height) => {
        if (running.current) throw new Error("Witness jobs must run sequentially");
        if (![width, height].every((value) => Number.isInteger(value) && value >= 256 && value <= 4096))
          throw new Error("Hero image dimensions must be whole pixels from 256 to 4096");
        running.current = true;
        try {
          resizeSurface(width, height);
          await frame();
          viewport.current!.view(pose);
          await frame();
          const canvas = document.querySelector<HTMLCanvasElement>(".atlas-viewport-canvas canvas");
          if (!canvas) throw new Error("Witness renderer has no canvas");
          const audit = pixelAudit(canvas);
          const image = document.createElement("canvas"); image.width = width; image.height = height;
          const context = image.getContext("2d")!;
          context.save(); context.translate(width / 2, height / 2); context.scale(width / 2, height / 2);
          const gradient = context.createRadialGradient(0, 0, 0, 0, 0, Math.SQRT2);
          gradient.addColorStop(0, "#2b3035"); gradient.addColorStop(0.47, "#181e26"); gradient.addColorStop(1, "#111720");
          context.fillStyle = gradient; context.fillRect(-1, -1, 2, 2); context.restore();
          context.drawImage(canvas, 0, 0, width, height);
          return { png: image.toDataURL("image/png"), view: { pose, ...audit, ...viewport.current!.captureMetadata() } };
        } finally { running.current = false; }
      },
    };
    return () => { delete window.atlasWitness; };
  }, []);
  return <AtlasViewport ref={viewport} scene={generation?.scene ?? null} appearance={generation?.spec.appearance ?? "tissue"} wireframe={false} onStats={(stats) => ready.current?.(stats)} onError={(message) => { failure.current = message; }} />;
}

if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Witness />);
