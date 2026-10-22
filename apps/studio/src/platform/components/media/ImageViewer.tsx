// An image with Preview-style zoom: fitted by default; pinch or ⌘/Ctrl-scroll zooms about the pointer, double-click
// toggles fit ↔ actual size, drag pans while zoomed, and the HUD (−, percentage, +) does the same from the keyboard.
// Used for images and textures in the Library inspector and Quick Look.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ImageOff, ZoomIn, ZoomOut } from "lucide-react";
import { cx, Icon, IconButton } from "../../ui";
import { clampOffset, fitScale, formatZoom, stepScale, wheelZoomFactor, zoomAbout, type Size, type ZoomState } from "./zoom";
import "./viewers.css";

export interface ImageViewerProps {
  /** A signed URL or an object URL; null shows an empty frame. */
  src: string | null;
  /** What the image shows ("Albedo map of Liver capsule"). */
  alt: string;
  /** A checkerboard behind transparent pixels (textures, PNGs with alpha). */
  checkerboard?: boolean | undefined;
  /** Hides the HUD until hover or focus (the inspector's small preview). */
  compact?: boolean | undefined;
  className?: string | undefined;
  /** The decoded size in pixels, once known. */
  onSize?: ((size: Size) => void) | undefined;
  onError?: (() => void) | undefined;
}

const PAN_STEP = 0.1;

export function ImageViewer({ src, alt, checkerboard = false, compact = false, className, onSize, onError }: ImageViewerProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  // null = fitted (follows the frame size); otherwise a fixed zoom chosen by the user
  const [zoom, setZoom] = useState<ZoomState | null>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; start: ZoomState } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setNatural(null);
    setFailed(false);
    setZoom(null);
  }, [src]);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return undefined;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = natural ? fitScale(natural, viewport) : 1;
  const state: ZoomState = zoom && natural ? clampOffset(zoom, natural, viewport) : { scale: fit, x: 0, y: 0 };
  const zoomed = natural !== null && (state.scale * natural.width > viewport.width + 0.5 || state.scale * natural.height > viewport.height + 0.5);

  const setScale = useCallback(
    (scale: number, anchor?: { x: number; y: number }) => {
      if (!natural) return;
      const point = anchor ?? { x: viewport.width / 2, y: viewport.height / 2 };
      const next = zoomAbout(state, scale, point, natural, viewport);
      setZoom(Math.abs(next.scale - fit) < 1e-4 && next.x === 0 && next.y === 0 ? null : next);
    },
    [natural, viewport, state, fit],
  );

  // wheel: pinch (ctrl) and ⌘-scroll zoom about the pointer; plain scrolling pans a zoomed image and otherwise scrolls the page
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!natural) return;
      const rect = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setScale(state.scale * wheelZoomFactor(event.deltaY, event.deltaMode), { x: event.clientX - rect.left, y: event.clientY - rect.top });
      } else if (zoomed) {
        event.preventDefault();
        setZoom(clampOffset({ ...state, x: state.x - event.deltaX, y: state.y - event.deltaY }, natural, viewport));
      }
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [natural, state, viewport, zoomed, setScale]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!zoomed || event.button !== 0 || (event.target as Element).closest(".px-image-viewer__hud")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: state };
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || !natural) return;
    setZoom(clampOffset({ ...current.start, x: current.start.x + event.clientX - current.x, y: current.start.y + event.clientY - current.y }, natural, viewport));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!natural || (event.target as Element).closest(".px-image-viewer__hud")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const target = Math.abs(state.scale - fit) < 1e-4 ? Math.max(1, fit * 2) : fit;
    if (target === fit) setZoom(null);
    else setScale(target, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!natural || event.metaKey || event.ctrlKey || event.altKey) return;
    const panX = viewport.width * PAN_STEP;
    const panY = viewport.height * PAN_STEP;
    switch (event.key) {
      case "+":
      case "=":
        setScale(stepScale(state.scale, 1, fit));
        break;
      case "-":
      case "_":
        setScale(stepScale(state.scale, -1, fit));
        break;
      case "0":
        setScale(1);
        break;
      case "9":
      case "f":
      case "F":
        setZoom(null);
        break;
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown":
        if (!zoomed) return;
        setZoom(
          clampOffset(
            {
              ...state,
              x: state.x + (event.key === "ArrowLeft" ? panX : event.key === "ArrowRight" ? -panX : 0),
              y: state.y + (event.key === "ArrowUp" ? panY : event.key === "ArrowDown" ? -panY : 0),
            },
            natural,
            viewport,
          ),
        );
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const showImage = Boolean(src) && !failed;
  const width = natural ? natural.width * state.scale : undefined;
  const height = natural ? natural.height * state.scale : undefined;

  return (
    <div
      ref={viewportRef}
      className={cx(
        "px-image-viewer",
        checkerboard && "px-image-viewer--checker",
        compact && "px-image-viewer--compact",
        zoomed && "px-image-viewer--zoomed",
        dragging && "px-image-viewer--dragging",
        className,
      )}
      role="group"
      aria-roledescription="image viewer"
      aria-label={alt}
      tabIndex={showImage && natural ? 0 : -1}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
    >
      {showImage ? (
        <img
          key={src}
          src={src ?? undefined}
          alt={alt}
          draggable={false}
          decoding="async"
          className="px-image-viewer__image"
          data-loaded={natural ? true : undefined}
          data-pixelated={state.scale >= 3 || undefined}
          style={
            natural
              ? { width, height, transform: `translate(calc(-50% + ${state.x}px), calc(-50% + ${state.y}px))` }
              : undefined
          }
          onLoad={(event) => {
            const image = event.currentTarget;
            const size = { width: image.naturalWidth, height: image.naturalHeight };
            setNatural(size);
            onSize?.(size);
          }}
          onError={() => {
            setFailed(true);
            onError?.();
          }}
        />
      ) : null}
      {failed ? (
        <div className="px-image-viewer__message" role="status">
          <Icon icon={ImageOff} size={24} />
          <span>Preview Unavailable</span>
        </div>
      ) : null}
      {showImage && natural ? (
        <div className="px-image-viewer__hud" role="group" aria-label="Zoom">
          <IconButton icon={ZoomOut} label="Zoom Out" size="small" tooltip={false} onClick={() => setScale(stepScale(state.scale, -1, fit))} />
          <button
            type="button"
            className="px-image-viewer__level px-num"
            aria-label={zoom ? `Zoom ${formatZoom(state.scale)}, fit to window` : `Zoom ${formatZoom(state.scale)}, show actual size`}
            onClick={() => (zoom ? setZoom(null) : setScale(1))}
          >
            {formatZoom(state.scale)}
          </button>
          <IconButton icon={ZoomIn} label="Zoom In" size="small" tooltip={false} onClick={() => setScale(stepScale(state.scale, 1, fit))} />
        </div>
      ) : null}
    </div>
  );
}
