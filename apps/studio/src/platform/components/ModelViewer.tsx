// The shared 3D preview (Library inspector, Quick Look, Imports): an orbitable GLB on a studio or dark stage. three.js
// is imported on first use (./media/modelStage), so pages that never show a model never download it. A new source or
// unmounting frees everything — geometries, materials, textures and the WebGL context. The turntable stops under
// Reduce Motion; plain scrolling passes over the viewer until it has focus, while pinch and ⌘/Ctrl-scroll always zoom.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { TriangleAlert } from "lucide-react";
import { Button, cx, Icon, Spinner, useLatest, usePrefersReducedMotion } from "../ui";
import { describeModelError } from "./media/modelErrors";
import type { ModelStage } from "./media/modelStage";
import "./media/viewers.css";

export type ModelSource = { kind: "url"; url: string } | { kind: "blob"; blob: Blob };

export interface ModelViewerProps {
  /** A GLB to show; null shows an empty stage. */
  source: ModelSource | null;
  /** Accessible description, e.g. "3D preview of Liver v2". */
  label: string;
  /** "studio" = neutral gradient (default); "dark" for lab-like previews. */
  background?: "studio" | "dark" | undefined;
  autoRotate?: boolean | undefined;
  wireframe?: boolean | undefined;
  className?: string | undefined;
  onStats?: ((stats: { vertices: number; triangles: number; meshes: number }) => void) | undefined;
  onError?: ((message: string) => void) | undefined;
}

type Status = "empty" | "loading" | "ready" | "error";

// a Blob has no identity a dependency list can compare cheaply; number them instead
const blobKeys = new WeakMap<Blob, number>();
let nextBlobKey = 1;

function sourceKey(source: ModelSource | null): string | null {
  if (!source) return null;
  if (source.kind === "url") return `url:${source.url}`;
  let key = blobKeys.get(source.blob);
  if (key === undefined) {
    key = nextBlobKey;
    nextBlobKey += 1;
    blobKeys.set(source.blob, key);
  }
  return `blob:${key}`;
}

const ORBIT_KEYS: Readonly<Record<string, [number, number]>> = {
  ArrowLeft: [1, 0],
  ArrowRight: [-1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
};

export function ModelViewer({ source, label, background = "studio", autoRotate = false, wireframe = false, className, onStats, onError }: ModelViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<ModelStage | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const hintId = useId();
  const key = sourceKey(source);
  const [status, setStatus] = useState<Status>(key ? "loading" : "empty");
  const [message, setMessage] = useState("");
  const [lost, setLost] = useState(false);
  // bumped by "Reload View" to rebuild the stage after the GPU dropped the context
  const [generation, setGeneration] = useState(0);
  const latest = useLatest({ source, autoRotate, wireframe, reducedMotion, onStats, onError });

  useEffect(() => {
    const host = hostRef.current;
    const current = latest.current.source;
    setLost(false);
    setMessage("");
    if (!host || !current) {
      setStatus("empty");
      return undefined;
    }
    setStatus("loading");
    const controller = new AbortController();
    let stage: ModelStage | null = null;
    void (async () => {
      try {
        const engine = await import("./media/modelStage");
        if (controller.signal.aborted) return;
        stage = new engine.ModelStage(host, {
          onContextLost: () => setLost(true),
          onContextRestored: () => setLost(false),
        });
        stageRef.current = stage;
        stage.setWireframe(latest.current.wireframe);
        stage.setAutoRotate(latest.current.autoRotate && !latest.current.reducedMotion);
        const bytes = await engine.readModelBytes(current, controller.signal);
        if (controller.signal.aborted) return;
        const stats = await stage.load(bytes, controller.signal);
        if (controller.signal.aborted) return;
        setStatus("ready");
        latest.current.onStats?.(stats);
      } catch (error) {
        if (controller.signal.aborted) return;
        const text = describeModelError(error);
        setMessage(text);
        setStatus("error");
        latest.current.onError?.(text);
      }
    })();
    return () => {
      controller.abort();
      stage?.dispose();
      if (stageRef.current === stage) stageRef.current = null;
    };
    // the source itself is read through `latest`; `key` is its identity
  }, [key, generation, latest]);

  useEffect(() => {
    stageRef.current?.setAutoRotate(autoRotate && !reducedMotion);
  }, [autoRotate, reducedMotion, status]);

  useEffect(() => {
    stageRef.current?.setWireframe(wireframe);
  }, [wireframe, status]);

  // plain wheel scrolling passes over an unfocused viewer (the inspector keeps scrolling); pinch and ⌘/Ctrl zoom
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || document.activeElement === host) return;
      event.stopPropagation();
    };
    host.addEventListener("wheel", onWheel, { capture: true });
    return () => host.removeEventListener("wheel", onWheel, { capture: true });
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage || status !== "ready" || event.metaKey || event.ctrlKey || event.altKey) return;
    const orbit = ORBIT_KEYS[event.key];
    if (orbit) stage.orbit(orbit[0], orbit[1]);
    else if (event.key === "f" || event.key === "F" || event.key === "Home") stage.frame();
    else if (event.key === "+" || event.key === "=") stage.zoom(1.2);
    else if (event.key === "-" || event.key === "_") stage.zoom(1 / 1.2);
    else {
      // Escape leaves the viewer (and still closes a surrounding dialog)
      if (event.key === "Escape") event.currentTarget.blur();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className={cx("px-model-viewer", `px-model-viewer--${background}`, className)} aria-busy={status === "loading" || undefined}>
      <div
        ref={hostRef}
        className="px-model-viewer__stage"
        role="img"
        aria-label={label}
        aria-describedby={status === "ready" ? hintId : undefined}
        tabIndex={status === "ready" ? 0 : -1}
        onKeyDown={onKeyDown}
        onPointerDownCapture={(event) => {
          // OrbitControls cancels pointerdown, which would keep focus (and the wheel) away from the viewer
          if (status === "ready") event.currentTarget.focus({ preventScroll: true });
        }}
        onDoubleClick={() => stageRef.current?.frame()}
      />
      <span id={hintId} hidden>
        Drag to rotate, right-drag to move, pinch or scroll to zoom. Arrow keys rotate, F frames the model.
      </span>
      {status === "loading" ? (
        <div className="px-model-viewer__overlay">
          <Spinner size={20} label="Loading 3D preview" />
        </div>
      ) : null}
      {status === "error" ? (
        <div className="px-model-viewer__overlay">
          <div className="px-model-viewer__message" role="status">
            <Icon icon={TriangleAlert} size={24} />
            <span>{message}</span>
          </div>
        </div>
      ) : null}
      {lost ? (
        <div className="px-model-viewer__overlay">
          <div className="px-model-viewer__hud" role="alert">
            <span>The 3D view stopped responding.</span>
            <Button size="small" onClick={() => setGeneration((value) => value + 1)}>
              Reload View
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
