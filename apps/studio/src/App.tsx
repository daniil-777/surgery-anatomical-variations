import { VideoRecorderButton } from "./VideoRecorderPanel";
import { WhistleMicButton } from "./whistleMic";
import { DisplaySettings, SceneResizeHandle } from "./DisplaySettings";
import { apiUrl, publicUrl, reportError, reportReady } from "./api";
import { ApiNotice } from "./ApiNotice";
import { MAX_PROJECT_BYTES, parseProject, validateScene } from "./project";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  CircleHelp,
  Copy,
  Download,
  Eye,
  EyeOff,
  Focus,
  Grab,
  Grid2X2,
  History,
  Layers3,
  LoaderCircle,
  Lock,
  Maximize2,
  MousePointer2,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  Redo2,
  RotateCcw,
  RotateCw,
  ScanLine,
  Settings2,
  ShieldCheck,
  Shuffle,
  Sparkles,
  Undo2,
  Unlock,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";
import { Button, IconButton, Section, Slider } from "@viscera/ui";
import {
  AnatomyViewport,
  type Appearance,
  type BrushStroke,
  type EditorTool,
  type OrganMesh,
  type SceneData,
  type ViewportHandle,
  type ProbeReport,
} from "@viscera/render";
import {
  bendMesh,
  brushMesh,
  meshMetrics,
  scaleMesh,
  validateSurfaceEdit,
} from "@viscera/geometry";
interface HistoryEntry {
  scene: SceneData;
  label: string;
  appearance: Record<string, Appearance>;
  hidden: Set<string>;
  locked: Set<string>;
  source: string;
  selected: string;
  seed: number;
}
interface TextResult {
  status: string;
  spec?: Record<string, unknown>;
  message?: string;
  changes?: { path: string; before: unknown; after: unknown; label: string }[];
  clarifications?: unknown[];
}
const defaults = (o: OrganMesh): Appearance => ({
  roughness: 0.48,
  clearcoat: 0.2,
  opacity: 1,
  wireframe: false,
  color:
    o.id === "liver"
      ? "#68332b"
      : o.id === "gallbladder"
        ? "#52652d"
        : (o.color ?? "#a65040"),
});
const tools: {
  id: EditorTool;
  label: string;
  key: string;
  icon: typeof Grab;
  description: string;
}[] = [
  {
    id: "orbit",
    label: "Navigate",
    key: "V",
    icon: MousePointer2,
    description: "Drag to orbit · scroll to zoom · right-drag to pan",
  },
  {
    id: "grab",
    label: "Grab",
    key: "G",
    icon: Grab,
    description: "Drag the surface to sculpt a local deformation",
  },
  {
    id: "inflate",
    label: "Inflate",
    key: "I",
    icon: Plus,
    description: "Drag across the surface to add local fullness",
  },
  {
    id: "twist",
    label: "Twist",
    key: "T",
    icon: RotateCw,
    description: "Drag to rotate a region around its surface normal",
  },
  {
    id: "smooth",
    label: "Smooth",
    key: "S",
    icon: WandSparkles,
    description: "Brush over small surface irregularities",
  },
  {
    id: "probe",
    label: "Probe",
    key: "P",
    icon: Activity,
    description:
      "Click to run a local tetrahedral displacement and recovery preview",
  },
];
const clone = <T,>(v: T): T => structuredClone(v);
function download(
  data: Blob | ArrayBuffer | string,
  name: string,
  type = "application/json",
) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function readSpecSeed(scene: SceneData | null) {
  const s = scene?.spec?.seed ?? scene?.parameters?.seed ?? 42;
  return typeof s === "number" ? s : 42;
}
export default function App() {
  const [scene, setScene] = useState<SceneData | null>(null),
    sceneRef = useRef<SceneData | null>(null);
  sceneRef.current = scene;
  const [selected, setSelected] = useState("liver"),
    [tool, setTool] = useState<EditorTool>("orbit"),
    [radius, setRadius] = useState(28),
    [strength, setStrength] = useState(0.65);
  const [hidden, setHidden] = useState<Set<string>>(new Set()),
    [locked, setLocked] = useState<Set<string>>(new Set()),
    [appearance, setAppearance] = useState<Record<string, Appearance>>({});
  const [tab, setTab] = useState<"shape" | "material" | "inspect">("shape"),
    [grid, setGrid] = useState(true),
    [clip, setClip] = useState<number | null>(null);
  const [loading, setLoading] = useState(true),
    [generating, setGenerating] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [source, setSource] = useState("Original procedural");
  const [stats, setStats] = useState({ fps: 0, triangles: 0, scalePx: 94 }),
    [probeDepth, setProbeDepth] = useState(0),
    [probeReport, setProbeReport] = useState<ProbeReport | null>(null),
    [seed, setSeed] = useState(42),
    [prompt, setPrompt] = useState(""),
    [compiling, setCompiling] = useState(false),
    [textResult, setTextResult] = useState<TextResult | null>(null);
  const [past, setPast] = useState<HistoryEntry[]>([]),
    [future, setFuture] = useState<HistoryEntry[]>([]),
    [events, setEvents] = useState<string[]>([
      "Original anatomy workspace initialized",
    ]);
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const editState = useRef<HistoryEntry | null>(null);
  const editAppearanceBase = useRef<Record<string, Appearance>>({});
  const generationBusy = useRef(false);
  const compilationId = useRef(0);
  const [recipe, setRecipe] = useState<Record<string, number> | null>(null);
  const editBase = useRef<SceneData | null>(null),
    editLabel = useRef("Surface edit"),
    viewport = useRef<ViewportHandle>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth > 850),
    [rightOpen, setRightOpen] = useState(() => window.innerWidth > 600),
    [exportOpen, setExportOpen] = useState(false),
    [helpOpen, setHelpOpen] = useState(false),
    [showHistory, setShowHistory] = useState(false);
  const [forms, setForms] = useState<
    Record<
      string,
      {
        width: number;
        depth: number;
        height: number;
        fullness: number;
        curvature: number;
      }
    >
  >({});
  const selectedOrgan =
    scene?.organs.find((o) => o.id === selected) ??
    scene?.vessels?.find((o) => o.id === selected);
  const metric = useMemo(
    () => (selectedOrgan ? meshMetrics(selectedOrgan) : null),
    [selectedOrgan],
  );
  const selectedAppearance = selectedOrgan
    ? (appearance[selected] ?? defaults(selectedOrgan))
    : null;
  const form = forms[selected] ?? {
    width: 100,
    depth: 100,
    height: 100,
    fullness: 100,
    curvature: 0,
  };
  const isLocked = locked.has(selected);
  const addEvent = useCallback(
    (label: string) => setEvents((e) => [label, ...e].slice(0, 40)),
    [],
  );
  const notify = useCallback((message: string) => {
    setNotice(message);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(id);
  }, [notice]);
  const editorState = useRef({
    appearance,
    hidden,
    locked,
    source,
    selected,
    seed,
  });
  editorState.current = { appearance, hidden, locked, source, selected, seed };
  const historyEntry = useCallback(
    (current: SceneData, label: string): HistoryEntry => ({
      scene: clone(current),
      label,
      ...clone(editorState.current),
      seed: readSpecSeed(current),
    }),
    [],
  );
  const restore = useCallback((item: HistoryEntry) => {
    sceneRef.current = clone(item.scene);
    setScene(sceneRef.current);
    setAppearance(clone(item.appearance));
    setHidden(new Set(item.hidden));
    setLocked(new Set(item.locked));
    setSource(item.source);
    setSelected(item.selected);
    setSeed(item.seed);
    setForms({});
    setRecipe(null);
    setProbeReport(null);
    editBase.current = null;
    editState.current = null;
  }, []);
  useEffect(() => {
    compilationId.current++;
    setTextResult(null);
  }, [scene, selected, prompt]);
  const adopt = useCallback((data: SceneData, kind = "Original procedural") => {
    validateScene(data);
    sceneRef.current = data;
    setScene(data);
    setSeed(readSpecSeed(data));
    setAppearance(
      Object.fromEntries(
        [...data.organs, ...(data.vessels ?? [])].map((o) => [
          o.id,
          defaults(o),
        ]),
      ),
    );
    setSelected((prev) =>
      data.organs.some((o) => o.id === prev) ? prev : data.organs[0]!.id,
    );
    setForms({});
    setRecipe(null);
    setProbeReport(null);
    editBase.current = null;
    editState.current = null;
    setSource(kind);
    setError("");
  }, []);
  const loadDefault = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      let data: SceneData;
      try {
        const response = await fetch(publicUrl("default-scene.json"));
        if (!response.ok) throw new Error("Bundled specimen unavailable");
        data = (await response.json()) as SceneData;
      } catch {
        const response = await fetch(apiUrl("/api/generate"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (!response.ok)
          throw new Error(
            "The bundled specimen and local generator are unavailable. Start the API service and reload.",
          );
        data = (await response.json()) as SceneData;
      }
      adopt(data);
      reportReady("legacy");
    } catch (e) {
      reportError(e instanceof Error ? e.message : "Scene could not be loaded");
      setError(e instanceof Error ? e.message : "Scene could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [adopt]);
  useEffect(() => {
    void loadDefault();
  }, [loadDefault]);
  const beginEdit = useCallback(
    (label = "Surface edit") => {
      if (!editBase.current && sceneRef.current) {
        editBase.current = sceneRef.current;
        editAppearanceBase.current = appearanceRef.current;
        editState.current = historyEntry(sceneRef.current, label);
        editLabel.current = label;
      }
    },
    [historyEntry],
  );
  const endEdit = useCallback(() => {
    if (editBase.current && sceneRef.current) {
      if (
        editBase.current === sceneRef.current &&
        editAppearanceBase.current === appearanceRef.current
      ) {
        editBase.current = null;
        editState.current = null;
        return;
      }
      const entry = editState.current!;
      const label = editLabel.current;
      setPast((p) => [...p, entry].slice(-24));
      setFuture([]);
      addEvent(label);
      editBase.current = null;
      editState.current = null;
    }
  }, [addEvent]);
  const mutateOrgan = useCallback(
    (id: string, positions: number[]) => {
      setScene((previous) => {
        if (!previous) return previous;
        const organ = previous.organs.find((o) => o.id === id);
        if (!organ) return previous;
        const check = validateSurfaceEdit(organ, positions);
        if (!check.valid) {
          notify(check.reason);
          return previous;
        }
        return {
          ...previous,
          organs: previous.organs.map((o) =>
            o.id === id
              ? {
                  ...o,
                  positions,
                  normals: undefined,
                  metadata: {
                    ...o.metadata,
                    editor_modified: true,
                    review_status: "unreviewed",
                    geometry_checks:
                      "local surface only; self-intersections not evaluated",
                  },
                }
              : o,
          ),
        } as SceneData;
      });
    },
    [notify],
  );
  const stroke = useCallback(
    (b: BrushStroke) => {
      if (locked.has(b.organId) || b.tool === "orbit" || b.tool === "probe")
        return;
      const o = sceneRef.current?.organs.find((o) => o.id === b.organId);
      if (!o) return;
      mutateOrgan(b.organId, brushMesh(o, { ...b, tool: b.tool }));
    },
    [locked, mutateOrgan],
  );
  const undo = useCallback(() => {
    if (!past.length || !scene) return;
    const item = past[past.length - 1]!;
    setFuture((f) => [...f, historyEntry(scene, item.label)]);
    restore(item);
    setPast((p) => p.slice(0, -1));
    notify(`Undid ${item.label.toLowerCase()}`);
  }, [past, scene, historyEntry, restore, notify]);
  const redo = useCallback(() => {
    if (!future.length || !scene) return;
    const item = future[future.length - 1]!;
    setPast((p) => [...p, historyEntry(scene, item.label)].slice(-24));
    restore(item);
    setFuture((f) => f.slice(0, -1));
    notify(`Redid ${item.label.toLowerCase()}`);
  }, [future, scene, historyEntry, restore, notify]);
  const applyForm = (key: keyof typeof form, value: number) => {
    if (!selectedOrgan || isLocked) return;
    beginEdit(`${selectedOrgan.name} ${key}`);
    const before = form[key];
    const positions =
      key === "curvature"
        ? bendMesh(selectedOrgan, value - before)
        : scaleMesh(
            selectedOrgan,
            key === "width"
              ? 0
              : key === "depth"
                ? 1
                : key === "height"
                  ? 2
                  : "all",
            key === "fullness" ? Math.cbrt(value / before) : value / before,
          );
    mutateOrgan(selected, positions);
    setForms((p) => ({ ...p, [selected]: { ...form, [key]: value } }));
  };
  const generate = useCallback(
    async (spec?: Record<string, unknown>) => {
      if (!sceneRef.current || generationBusy.current) return;
      generationBusy.current = true;
      const old = sceneRef.current;
      const before = historyEntry(old, "Generate specimen");
      setGenerating(true);
      setError("");
      try {
        const target = spec ?? { ...(old.spec ?? {}), seed };
        const editing = target.seed === (old.spec?.seed ?? seed);
        let endpoint = "/api/generate";
        let body: Record<string, unknown> = {
          spec: target,
          resolution: "medium",
        };
        if (editing || locked.size) {
          const upload = await fetch(apiUrl("/api/snapshots"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scene: old }),
          });
          if (!upload.ok)
            throw new Error(
              "The current surface could not pass the snapshot checks. Save the project before regenerating.",
            );
          const snapshot = (await upload.json()) as {
            id: string;
            content_hash: string;
          };
          endpoint = "/api/edit";
          body = {
            ...body,
            base_snapshot_id: snapshot.id,
            expected_content_hash: snapshot.content_hash,
            locked_organ_ids: [...locked].filter(
              (id) => id === "liver" || id === "gallbladder",
            ),
          };
        }
        const response = await fetch(apiUrl(endpoint), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          let reason = `Generation failed (${response.status})`;
          try {
            const detail = (
              (await response.json()) as {
                detail?: string | { message?: string; code?: string };
              }
            ).detail;
            reason =
              typeof detail === "string"
                ? detail
                : (detail?.message ?? detail?.code ?? reason);
          } catch {
            reason =
              "Generation service is offline. Local editing and project export remain available.";
          }
          throw new Error(reason);
        }
        const payload = (await response.json()) as SceneData & {
          scene?: SceneData;
          snapshot?: SceneData["snapshot"];
        };
        const data = payload.scene
          ? {
              ...payload.scene,
              ...(payload.snapshot ? { snapshot: payload.snapshot } : {}),
            }
          : payload;
        validateScene(data);
        if (sceneRef.current !== old || editorState.current.locked !== locked)
          throw new Error(
            "The specimen changed while generation was running. Your current edits were preserved; generate again to use them.",
          );
        setPast((p) =>
          [
            ...p,
            {
              ...before,
              label: editing ? "Apply anatomy parameters" : "Generate specimen",
            },
          ].slice(-24),
        );
        setFuture([]);
        const currentAppearance = appearanceRef.current;
        adopt(data);
        if (editing) setAppearance(currentAppearance);
        addEvent(
          `${editing ? "Updated anatomy" : "Generated specimen"} · seed ${String(target.seed ?? seed)}`,
        );
        notify(
          editing
            ? "Anatomy updated; unchanged surfaces preserved."
            : "New specimen generated",
        );
      } catch (e) {
        notify(e instanceof Error ? e.message : "Generation failed");
      } finally {
        generationBusy.current = false;
        setGenerating(false);
      }
    },
    [seed, locked, adopt, addEvent, notify, historyEntry],
  );
  const newVariation = async () => {
    if (generationBusy.current || !sceneRef.current) return;
    const base = sceneRef.current;
    generationBusy.current = true;
    setGenerating(true);
    try {
      const newSeed = Math.floor(Math.random() * 4294967296);
      const response = await fetch(apiUrl(`/api/variation/${newSeed}`));
      if (!response.ok) throw new Error("Variation service unavailable");
      const spec = (await response.json()) as Record<string, unknown>;
      if (sceneRef.current !== base)
        throw new Error(
          "The specimen changed while sampling. Your current edits were preserved.",
        );
      generationBusy.current = false;
      setSeed(newSeed);
      await generate(spec);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Variation failed");
    } finally {
      generationBusy.current = false;
      setGenerating(false);
    }
  };
  const sampleLearned = async () => {
    if (generationBusy.current) return;
    if (!scene || locked.size) {
      notify("Unlock the scene before sampling a new learned variation.");
      return;
    }
    generationBusy.current = true;
    const old = scene;
    const before = historyEntry(old, "Learned parameter variation");
    setGenerating(true);
    try {
      const response = await fetch(apiUrl("/api/sample-learned"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seed, conditions: {}, resolution: "medium" }),
      });
      if (!response.ok) {
        const result = (await response.json()) as {
          detail?: string | { message?: string };
        };
        throw new Error(
          typeof result.detail === "string"
            ? result.detail
            : (result.detail?.message ??
              "The learned sample was rejected. Choose another seed; the scene is unchanged."),
        );
      }
      const data = (await response.json()) as SceneData;
      validateScene(data);
      if (sceneRef.current !== old || editorState.current.locked !== locked)
        throw new Error(
          "The specimen changed while sampling. Your current edits were preserved; sample again to use them.",
        );
      setPast((p) => [...p, before].slice(-24));
      setFuture([]);
      adopt(data, "Learned parameter pilot");
      addEvent("Sampled an experimental learned parameter flow");
      notify(
        "Learned parameters sampled; surface construction remains procedural and unreviewed.",
      );
    } catch (error) {
      notify(
        error instanceof Error
          ? error.message
          : "Learned sampling is unavailable",
      );
    } finally {
      generationBusy.current = false;
      setGenerating(false);
    }
  };
  const compile = async (overrideText?: string) => {
    const text = (overrideText ?? prompt).trim();
    if (!text || !scene || compiling) return;
    if (overrideText !== undefined) setPrompt(overrideText);
    const base = scene;
    const requestId = ++compilationId.current;
    setCompiling(true);
    setTextResult(null);
    try {
      const res = await fetch(apiUrl("/api/compile"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          spec: scene.spec ?? {},
          selectedOrganId: selected,
        }),
      });
      if (!res.ok)
        throw new Error(
          "Text compiler is unavailable. Geometry and material controls work locally.",
        );
      const result = (await res.json()) as TextResult;
      if (requestId !== compilationId.current || sceneRef.current !== base)
        return;
      setTextResult(result);
      if (result.status === "ready" && result.spec) {
        notify("Review the interpreted changes, then apply them.");
      }
    } catch (e) {
      if (requestId !== compilationId.current || sceneRef.current !== base)
        return;
      setTextResult({
        status: "error",
        message:
          e instanceof Error ? e.message : "Could not interpret the request",
      });
    } finally {
      setCompiling(false);
    }
  };
  const saveProject = () => {
    if (!scene) return;
    download(
      JSON.stringify(
        {
          format: "viscera-studio-project",
          version: "0.1.0",
          scene,
          appearance,
          hidden: [...hidden],
          locked: [...locked],
          history: events,
          limitations: [
            "Original procedural anatomy; expert review not performed",
            "Surface geometry editing; volumetric mechanics and self-contact not verified",
          ],
        },
        null,
        2,
      ),
      `viscera-specimen-${seed}.json`,
    );
    setExportOpen(false);
    notify("Project saved with geometry, appearance and evidence status");
  };
  const saveGLB = async () => {
    try {
      const buffer = await viewport.current?.exportGLB();
      if (buffer) {
        download(buffer, `viscera-specimen-${seed}.glb`, "model/gltf-binary");
        notify("GLB exported in metres · visible geometry only");
      }
    } catch (e) {
      notify(e instanceof Error ? e.message : "GLB export failed");
    }
    setExportOpen(false);
  };
  const importProject = async (file: File) => {
    try {
      if (file.size > MAX_PROJECT_BYTES)
        throw new Error("Project exceeds the 32 MiB import limit");
      const data = parseProject(JSON.parse(await file.text()));
      const old = sceneRef.current;
      const before = old ? historyEntry(old, "Import project") : null;
      adopt(data.scene, "Imported project");
      setAppearance(
        Object.fromEntries(
          [...data.scene.organs, ...(data.scene.vessels ?? [])].map((organ) => [
            organ.id,
            data.appearance[organ.id] ?? defaults(organ),
          ]),
        ),
      );
      setHidden(data.hidden);
      setLocked(data.locked);
      if (before) setPast((p) => [...p, before].slice(-24));
      setFuture([]);
      addEvent("Imported project");
      notify("Project opened");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Invalid project file");
    }
  };
  const toggleSet = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    id: string,
  ) =>
    setter((v) => {
      const next = new Set(v);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement).matches(
          "input,textarea,select,[contenteditable=true]",
        )
      )
        return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveProject();
        return;
      }
      const t = tools.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (t) {
        setTool(t.id);
        if (t.id !== "orbit") setTab("shape");
      }
      if (e.key.toLowerCase() === "f") viewport.current?.fit();
      if (e.key === "Escape") {
        setTool("orbit");
        setTextResult(null);
        setExportOpen(false);
      }
      if (e.key === "?") setHelpOpen((v) => !v);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const allOrgans = [...(scene?.organs ?? []), ...(scene?.vessels ?? [])];
  const currentTool = tools.find((t) => t.id === tool)!;
  return (
    <div
      className={`studio ${leftOpen ? "" : "left-collapsed"} ${rightOpen ? "" : "right-collapsed"}`}
    >
      <header className="topbar"><DisplaySettings /><VideoRecorderButton />
        <div className="brand">
          <span className="brand-mark">
            <Activity size={20} />
          </span>
          <span>
            VISCERA<span className="brand-sub">STUDIO</span>
          </span>
        </div>
        <span className="top-divider" />
        <div className="project-title">
          Abdominal anatomy
          <span className="project-dot" />
          <span className="project-subtitle">Untitled specimen</span>
        </div>
        <span className="topbar-spacer" />
        <a href="?mode=atlas" className="button subtle" style={{ textDecoration: "none", fontSize: 11 }}><Layers3 size={14} /> Atlas library</a>
        <span className="preview-label">
          <span />
          Development preview
        </span>
        <div className="history-actions">
          <IconButton
            title="Undo (⌘Z)"
            disabled={!past.length}
            onClick={undo}
            data-testid="undo"
          >
            <Undo2 size={16} />
          </IconButton>
          <IconButton
            title="Redo (⌘⇧Z)"
            disabled={!future.length}
            onClick={redo}
            data-testid="redo"
          >
            <Redo2 size={16} />
          </IconButton>
        </div>
        <IconButton
          title="Open project"
          onClick={() => fileInput.current?.click()}
        >
          <Upload size={16} />
        </IconButton>
        <div className="export-wrap">
          <Button
            onClick={() => setExportOpen((v) => !v)}
            data-testid="export-menu"
          >
            <ArrowDownToLine size={14} />
            Export
            <ChevronDown size={12} />
          </Button>
          {exportOpen && (
            <div className="menu export-menu">
              <button onClick={saveProject}>
                <Copy size={15} />
                <span>
                  Studio project<small>JSON · editable geometry</small>
                </span>
              </button>
              <button onClick={() => void saveGLB()}>
                <Box size={15} />
                <span>
                  3D model<small>GLB · metres · visible objects</small>
                </span>
              </button>
              <button
                onClick={() => {
                  const url = viewport.current?.screenshot();
                  if (url) {
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `viscera-${seed}.png`;
                    a.click();
                  }
                  setExportOpen(false);
                }}
              >
                <Focus size={15} />
                <span>
                  Viewport image<small>PNG · current view</small>
                </span>
              </button>
            </div>
          )}
        </div>
        <IconButton
          title="Shortcuts and capability notes"
          onClick={() => setHelpOpen(true)}
        >
          <CircleHelp size={17} />
        </IconButton>
        <ApiNotice />
      </header>
      <aside className="outliner">
        <div className="panel-top">
          <span>SCENE</span>
          <IconButton
            title="Collapse scene panel"
            onClick={() => setLeftOpen(false)}
          >
            <PanelLeftClose size={14} />
          </IconButton>
        </div>
        <div className="collection-row">
          <ChevronDown size={13} />
          <Layers3 size={14} />
          <strong>Abdominal collection</strong>
          <span>{allOrgans.length.toString().padStart(2, "0")}</span>
        </div>
        <div className="outliner-list">
          {scene?.organs.map((o) => (
            <div
              key={o.id}
              className={`object-row ${selected === o.id ? "selected" : ""}`}
              data-testid={`organ-${o.id}`}
            >
              <button
                className="object-select"
                onClick={() => setSelected(o.id)}
              >
                <span
                  className="organ-swatch"
                  style={{ background: o.color }}
                />
                <span>
                  {o.name}
                  <small>{o.kind}</small>
                </span>
              </button>
              <IconButton
                title={`${hidden.has(o.id) ? "Show" : "Hide"} ${o.name}`}
                onClick={() => toggleSet(setHidden, o.id)}
              >
                {hidden.has(o.id) ? <EyeOff size={13} /> : <Eye size={13} />}
              </IconButton>
              <IconButton
                title={`${locked.has(o.id) ? "Unlock" : "Lock"} ${o.name}`}
                active={locked.has(o.id)}
                onClick={() => toggleSet(setLocked, o.id)}
              >
                {locked.has(o.id) ? <Lock size={12} /> : <Unlock size={12} />}
              </IconButton>
            </div>
          ))}
          {(scene?.vessels?.length ?? 0) > 0 && (
            <>
              <div className="vessels-heading">VASCULATURE & DUCTS</div>
              {scene?.vessels?.map((o) => (
                <div
                  className={`object-row vessel-row ${selected === o.id ? "selected" : ""}`}
                  key={o.id}
                >
                  <button
                    className="object-select"
                    onClick={() => setSelected(o.id)}
                  >
                    <span
                      className="vessel-swatch"
                      style={{ background: o.color }}
                    />
                    <span>{o.name}</span>
                  </button>
                  <IconButton
                    title={`${hidden.has(o.id) ? "Show" : "Hide"} ${o.name}`}
                    onClick={() => toggleSet(setHidden, o.id)}
                  >
                    {hidden.has(o.id) ? (
                      <EyeOff size={13} />
                    ) : (
                      <Eye size={13} />
                    )}
                  </IconButton>
                </div>
              ))}
            </>
          )}
        </div>
        <div className="outliner-bottom">
          <div className="specimen-preview">
            <div className="tiny-anatomy">
              <Activity size={34} strokeWidth={1} />
            </div>
            <div>
              <strong>Specimen {seed.toString().padStart(4, "0")}</strong>
              <small>{source}</small>
            </div>
            <span className="badge">MM</span>
          </div>
          <div className="seed-row">
            <label htmlFor="seed">Variation seed</label>
            <input
              id="seed"
              data-testid="seed-input"
              type="number"
              min="0"
              max="4294967295"
              value={seed}
              onChange={(e) =>
                setSeed(
                  Math.min(
                    4294967295,
                    Math.max(0, Math.floor(Number(e.target.value)) || 0),
                  ),
                )
              }
            />
          </div>
          <Button
            onClick={() => void newVariation()}
            disabled={generating || !scene}
            data-testid="new-variation"
          >
            {generating ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <Shuffle size={14} />
            )}
            New variation
          </Button>
          <button
            className="quiet-link"
            onClick={() => void generate()}
            disabled={generating}
          >
            Regenerate from seed <ArrowRight size={12} />
          </button>
          <button
            className="learned-pilot-button"
            data-testid="sample-learned"
            onClick={() => void sampleLearned()}
            disabled={generating || !scene || locked.size > 0}
          >
            <Sparkles size={12} />
            <span>
              Sample learned pilot<small>Experimental · parameter flow</small>
            </span>
            <ArrowRight size={12} />
          </button>
          <div className="evidence-note">
            <ShieldCheck size={14} />
            <span>
              Procedural geometry
              <br />
              <strong>Expert review pending</strong>
            </span>
          </div>
        </div>
      </aside>
      <main className="workspace"><SceneResizeHandle />
        <div className="viewport-topline">
          <div className="view-title">
            PERSPECTIVE
            <span />
            Anatomical view
          </div>
          <div className="viewport-actions">
            {!leftOpen && (
              <IconButton
                title="Open scene panel"
                onClick={() => setLeftOpen(true)}
              >
                <Layers3 size={15} />
              </IconButton>
            )}
            <IconButton
              title="Ground grid"
              active={grid}
              onClick={() => setGrid((v) => !v)}
            >
              <Grid2X2 size={15} />
            </IconButton>
            <IconButton
              title="Fit anatomy (F)"
              onClick={() => viewport.current?.fit()}
            >
              <Maximize2 size={15} />
            </IconButton>
            {!rightOpen && (
              <IconButton
                title="Open inspector"
                onClick={() => setRightOpen(true)}
              >
                <Settings2 size={15} />
              </IconButton>
            )}
          </div>
        </div>
        <AnatomyViewport
          ref={viewport}
          scene={scene}
          selectedId={selected}
          hidden={hidden}
          locked={locked}
          tool={tool}
          radius={radius}
          strength={strength}
          appearance={appearance}
          clip={clip}
          showGrid={grid}
          onSelect={setSelected}
          onStrokeStart={() => beginEdit(`${currentTool.label} brush`)}
          onStroke={stroke}
          onStrokeEnd={endEdit}
          onStats={setStats}
          onProbe={setProbeDepth}
          onProbeReport={setProbeReport}
          onError={setError}
          onNotice={notify}
        />
        {(loading || generating) && (
          <div
            className={`viewport-loading ${generating ? "regenerating" : ""}`}
          >
            <div className="scan-orbit" />
            <strong>
              {generating
                ? "Constructing a new specimen"
                : "Preparing your anatomy"}
            </strong>
            <span>Original procedural geometry</span>
          </div>
        )}
        {error && (
          <div className="viewport-error">
            <CircleHelp size={24} />
            <strong>Unable to open the specimen</strong>
            <p>{error}</p>
            <Button onClick={() => void loadDefault()}>Try again</Button>
          </div>
        )}
        <div className="tool-rail" role="toolbar" aria-label="Geometry tools">
          {tools.map((t) => (
            <button
              key={t.id}
              className={`tool-button ${tool === t.id ? "active" : ""}`}
              title={`${t.label} (${t.key})`}
              aria-label={t.label}
              aria-pressed={tool === t.id}
              data-testid={`tool-${t.id}`}
              onClick={() => {
                setTool(t.id);
                if (t.id !== "orbit") setTab("shape");
              }}
            >
              <t.icon size={19} strokeWidth={1.5} />
              <span>{t.key}</span>
            </button>
          ))}
          <span className="tool-divider" />
          <button
            className={`tool-button ${clip !== null ? "active" : ""}`}
            aria-label="Section view"
            title="Section view"
            onClick={() => setClip((v) => (v === null ? 0 : null))}
          >
            <ScanLine size={19} />
          </button>
        </div>
        <div className="orientation-gizmo">
          <button
            title="Anterior view"
            onClick={() => viewport.current?.camera("anterior")}
          >
            A
          </button>
          <button
            title="Superior view"
            onClick={() => viewport.current?.camera("superior")}
          >
            S
          </button>
          <button
            title="Posterior view"
            onClick={() => viewport.current?.camera("posterior")}
          >
            P
          </button>
          <button
            className="gizmo-center"
            title="Oblique view"
            onClick={() => viewport.current?.camera("oblique")}
          >
            <Box size={19} strokeWidth={1.2} />
          </button>
          <span className="axis-x">R</span>
          <span className="axis-z">S</span>
        </div>
        <div className="viewport-caption">
          <span className="selected-pill">
            <span style={{ background: selectedOrgan?.color ?? "#a65040" }} />
            {selectedOrgan?.name ?? "No selection"}
            {isLocked && <Lock size={11} />}
          </span>
          <span className="mesh-caption">
            {metric
              ? `${metric.vertices.toLocaleString()} vertices · ${metric.triangles.toLocaleString()} faces`
              : ""}
          </span>
        </div>
        <div
          className="viewport-scale"
          style={{ width: stats.scalePx }}
          title="Approximate scale at the camera target plane"
        >
          <i />
          <span>50 mm</span>
          <i />
        </div>
        {tool !== "orbit" && (
          <div className="tool-hint">
            <currentTool.icon size={14} />
            <strong>{currentTool.label}</strong>
            <span>{currentTool.description}</span>
            <kbd className="keyhint">V</kbd>
          </div>
        )}
        {probeDepth !== 0 && (
          <div className="probe-readout">
            <Activity size={14} />
            <span>Preview displacement</span>
            <strong>
              {Math.abs(probeDepth).toFixed(2)} <small>mm</small>
            </strong>
          </div>
        )}
        <div className="prompt-dock">
          <div className="prompt-input-wrap">
            <Sparkles size={17} />
            <textarea
              rows={1}
              aria-label="Describe an anatomy change"
              data-testid="text-prompt"
              placeholder="Describe a change…  e.g. “increase liver width by 10%”"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void compile();
                }
              }}
            />
            <span className="prompt-local">Typed spec</span>
            <WhistleMicButton
              className="prompt-mic whistle-mic-btn"
              disabled={compiling || !scene}
              onTranscript={(liveText) => setPrompt(liveText)}
              onCommit={(cleanText) => {
                setPrompt(cleanText);
                void compile(cleanText);
              }}
            />
            <button
              className="prompt-submit"
              aria-label="Interpret request"
              data-testid="compile-prompt"
              disabled={compiling || !prompt.trim() || !scene}
              onClick={() => void compile()}
            >
              {compiling ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <ArrowRight size={17} />
              )}
            </button>
          </div>
          {textResult && (
            <div className={`text-result ${textResult.status}`}>
              <div>
                <span className="result-label">
                  {textResult.status === "ready"
                    ? "INTERPRETED CHANGE"
                    : textResult.status.replaceAll("_", " ").toUpperCase()}
                </span>
                <IconButton
                  title="Dismiss interpretation"
                  onClick={() => setTextResult(null)}
                >
                  <X size={13} />
                </IconButton>
              </div>
              <p>
                {textResult.message ??
                  "Review the change before updating the specimen."}
              </p>
              {textResult.changes?.map((c, i) => (
                <div className="change-line" key={i}>
                  <span>{c.label ?? c.path}</span>
                  <code>
                    {String(c.before)} → {String(c.after)}
                  </code>
                </div>
              ))}
              {textResult.status === "ready" && textResult.spec && (
                <Button
                  primary
                  disabled={generating}
                  onClick={() => {
                    void generate(textResult.spec);
                    setTextResult(null);
                    setPrompt("");
                  }}
                >
                  Apply to specimen <ArrowRight size={13} />
                </Button>
              )}
            </div>
          )}
        </div>
      </main>
      <aside className="inspector">
        <div className="panel-top">
          <span>INSPECTOR</span>
          <IconButton
            title="Collapse inspector"
            onClick={() => setRightOpen(false)}
          >
            <PanelRightClose size={14} />
          </IconButton>
        </div>
        <div className="inspector-selection">
          <span
            className="selection-marker"
            style={{ background: selectedOrgan?.color }}
          />
          <div>
            <h2>{selectedOrgan?.name ?? "No selection"}</h2>
            <span>Original procedural surface</span>
          </div>
          <IconButton
            title={isLocked ? "Unlock selected organ" : "Lock selected organ"}
            disabled={!scene?.organs.some((o) => o.id === selected)}
            active={isLocked}
            onClick={() => toggleSet(setLocked, selected)}
          >
            {isLocked ? <Lock size={14} /> : <Unlock size={14} />}
          </IconButton>
        </div>
        <div className="inspector-tabs">
          {(["shape", "material", "inspect"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={tab === t ? "active" : ""}
            >
              {t === "inspect" ? "Evidence" : t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div className="inspector-scroll">
          {tab === "shape" && (
            <>
              <Section
                title="Dimensions"
                aside={<span className="small-label">Surface edit</span>}
              >
                <div className="dimensions-row">
                  <div>
                    <span>WIDTH</span>
                    <strong>
                      {metric?.dimensions[0].toFixed(1) ?? "—"}
                      <small>mm</small>
                    </strong>
                  </div>
                  <div>
                    <span>DEPTH</span>
                    <strong>
                      {metric?.dimensions[1].toFixed(1) ?? "—"}
                      <small>mm</small>
                    </strong>
                  </div>
                  <div>
                    <span>HEIGHT</span>
                    <strong>
                      {metric?.dimensions[2].toFixed(1) ?? "—"}
                      <small>mm</small>
                    </strong>
                  </div>
                </div>
                <Slider
                  label="Width"
                  value={form.width}
                  min={65}
                  max={140}
                  unit="%"
                  onChange={(v) => applyForm("width", v)}
                  onStart={() => beginEdit("Width adjustment")}
                  onEnd={endEdit}
                  disabled={
                    isLocked || !scene?.organs.some((o) => o.id === selected)
                  }
                  testId="width-slider"
                />
                <Slider
                  label="Depth"
                  value={form.depth}
                  min={65}
                  max={140}
                  unit="%"
                  onChange={(v) => applyForm("depth", v)}
                  onStart={() => beginEdit("Depth adjustment")}
                  onEnd={endEdit}
                  disabled={
                    isLocked || !scene?.organs.some((o) => o.id === selected)
                  }
                />
                <Slider
                  label="Height"
                  value={form.height}
                  min={65}
                  max={140}
                  unit="%"
                  onChange={(v) => applyForm("height", v)}
                  onStart={() => beginEdit("Height adjustment")}
                  onEnd={endEdit}
                  disabled={
                    isLocked || !scene?.organs.some((o) => o.id === selected)
                  }
                />
              </Section>
              <Section
                title="Anatomy recipe"
                aside={<span className="small-label">Procedural</span>}
              >
                {(selected === "liver"
                  ? [
                      {
                        key: "left_lobe_ratio",
                        label: "Left lobe proportion",
                        min: 0.3,
                        max: 0.78,
                        step: 0.01,
                        initial: 0.48,
                        unit: "",
                      },
                      {
                        key: "inferior_concavity",
                        label: "Inferior concavity",
                        min: 0.1,
                        max: 0.55,
                        step: 0.01,
                        initial: 0.3,
                        unit: "",
                      },
                      {
                        key: "fissure_depth_mm",
                        label: "Fissure depth",
                        min: 2,
                        max: 12,
                        step: 0.5,
                        initial: 7,
                        unit: "mm",
                      },
                    ]
                  : selected === "gallbladder"
                    ? [
                        {
                          key: "gallbladder_length_mm",
                          label: "Body length",
                          min: 55,
                          max: 110,
                          step: 1,
                          initial: 80,
                          unit: "mm",
                        },
                        {
                          key: "gallbladder_radius_mm",
                          label: "Body radius",
                          min: 10,
                          max: 22,
                          step: 0.5,
                          initial: 15,
                          unit: "mm",
                        },
                      ]
                    : []
                ).map((control) => (
                  <Slider
                    key={control.key}
                    label={control.label}
                    value={
                      recipe?.[control.key] ??
                      (typeof scene?.parameters?.[control.key] === "number"
                        ? (scene.parameters[control.key] as number)
                        : control.initial)
                    }
                    min={control.min}
                    max={control.max}
                    step={control.step}
                    unit={control.unit}
                    disabled={
                      isLocked || !scene?.organs.some((o) => o.id === selected)
                    }
                    onChange={(v) =>
                      setRecipe((p) => ({ ...p, [control.key]: v }))
                    }
                  />
                ))}
                {recipe && (
                  <Button
                    primary
                    disabled={generating || isLocked}
                    onClick={() =>
                      void generate({
                        ...scene?.spec,
                        parameters: {
                          ...((scene?.spec?.parameters as Record<
                            string,
                            number
                          >) ?? {}),
                          ...recipe,
                        },
                      })
                    }
                  >
                    <RotateCw size={13} />
                    Rebuild anatomy
                  </Button>
                )}
                <p className="field-note">
                  Authored shape controls. Rebuilding a sculpted organ requires
                  a new specimen; unrelated surfaces are preserved.
                </p>
              </Section>
              <Section title="Form">
                <Slider
                  label="Volume scale"
                  value={form.fullness}
                  min={65}
                  max={145}
                  unit="%"
                  onChange={(v) => applyForm("fullness", v)}
                  onStart={() => beginEdit("Volume scale")}
                  onEnd={endEdit}
                  disabled={
                    isLocked || !scene?.organs.some((o) => o.id === selected)
                  }
                />
                <Slider
                  label="Long-axis curvature"
                  value={form.curvature}
                  min={-40}
                  max={40}
                  unit="mm"
                  onChange={(v) => applyForm("curvature", v)}
                  onStart={() => beginEdit("Curvature adjustment")}
                  onEnd={endEdit}
                  disabled={
                    isLocked || !scene?.organs.some((o) => o.id === selected)
                  }
                />
                <div className="measurement-row">
                  <span>Enclosed mesh volume</span>
                  <strong>
                    {metric?.volumeMl.toFixed(1) ?? "—"} <small>mL</small>
                  </strong>
                </div>
                <p className="field-note">
                  Measured from this surface. Tissue and lumen volumes are not
                  distinguished.
                </p>
              </Section>
              <Section
                title={
                  tool === "orbit"
                    ? "Local sculpt"
                    : `${currentTool.label} brush`
                }
                aside={<span className="badge">LIVE</span>}
              >
                <div className="brush-types">
                  {tools
                    .filter((t) => t.id !== "orbit")
                    .map((t) => (
                      <button
                        key={t.id}
                        className={tool === t.id ? "active" : ""}
                        title={t.label}
                        aria-label={`${t.label} brush`}
                        onClick={() => setTool(t.id)}
                      >
                        <t.icon size={15} />
                      </button>
                    ))}
                </div>
                <Slider
                  label="Radius"
                  value={radius}
                  min={6}
                  max={65}
                  unit="mm"
                  onChange={setRadius}
                />
                <Slider
                  label="Strength"
                  value={Math.round(strength * 100)}
                  min={5}
                  max={100}
                  unit="%"
                  onChange={(v) => setStrength(v / 100)}
                />
                <p className="field-note">
                  Connectivity preserved. Local triangle guards are active;
                  anatomical validity requires review.
                </p>
              </Section>
              <Section title="Interaction preview">
                <Button
                  onClick={() => {
                    setTool("probe");
                    viewport.current?.runProbe();
                  }}
                  disabled={!scene}
                  data-testid="run-probe"
                >
                  <Activity size={14} />
                  Run probe & recovery
                </Button>
                <p className="field-note">
                  Tetrahedral XPBD displacement preview. Unedited liver only; no
                  calibrated contact-force claim.
                </p>
                {probeReport && (
                  <div
                    className="probe-report"
                    data-testid="probe-report"
                    data-status={probeReport.status}
                  >
                    <div>
                      <span>Simulation time</span>
                      <strong>{probeReport.time.toFixed(2)} s</strong>
                    </div>
                    <div>
                      <span>Peak displacement</span>
                      <strong>
                        {probeReport.maxDisplacementMm.toFixed(2)} mm
                      </strong>
                    </div>
                    <div>
                      <span>Recovery residual</span>
                      <strong>
                        {probeReport.recoveryResidualMm.toFixed(3)} mm
                      </strong>
                    </div>
                    <div>
                      <span>Minimum Jacobian</span>
                      <strong>{probeReport.minJacobian.toFixed(3)}</strong>
                    </div>
                    <div>
                      <span>Max volume drift</span>
                      <strong>
                        {(probeReport.maxVolumeDrift * 100).toFixed(2)}%
                      </strong>
                    </div>
                    <div>
                      <span>Rejected steps</span>
                      <strong>{probeReport.rejectedSteps}</strong>
                    </div>
                    <div className="probe-report-actions">
                      <Button
                        onClick={() => {
                          viewport.current?.resetSimulation();
                          notify(
                            "Reference surface restored; the recorded test report is retained.",
                          );
                        }}
                      >
                        <RotateCcw size={12} />
                        Reset
                      </Button>
                      <Button
                        onClick={() =>
                          download(
                            JSON.stringify(
                              {
                                model: "tetrahedral_xpbd_preview",
                                protocol:
                                  "distributed-displacement-recovery-v1",
                                units: "SI",
                                calibrated: false,
                                ...probeReport,
                              },
                              null,
                              2,
                            ),
                            `viscera-probe-${seed}.json`,
                          )
                        }
                      >
                        <Download size={12} />
                        Report
                      </Button>
                    </div>
                  </div>
                )}
              </Section>
            </>
          )}
          {tab === "material" && selectedAppearance && (
            <>
              <Section title="Wet tissue material">
                <div
                  className="material-preview"
                  style={
                    {
                      "--tissue-color": selectedAppearance.color,
                    } as React.CSSProperties
                  }
                >
                  <span />
                </div>
                <div className="color-row">
                  <span>Base color</span>
                  <code>{selectedAppearance.color.toUpperCase()}</code>
                  <input
                    type="color"
                    aria-label="Tissue base color"
                    value={selectedAppearance.color}
                    onFocus={() => beginEdit("Material color")}
                    onBlur={endEdit}
                    onChange={(e) => {
                      beginEdit("Material color");
                      setAppearance((a) => ({
                        ...a,
                        [selected]: {
                          ...selectedAppearance,
                          color: e.target.value,
                        },
                      }));
                    }}
                  />
                </div>
                <Slider
                  label="Surface roughness"
                  value={selectedAppearance.roughness}
                  min={0.15}
                  max={0.9}
                  step={0.01}
                  onStart={() => beginEdit("Surface roughness")}
                  onEnd={endEdit}
                  onChange={(v) =>
                    setAppearance((a) => ({
                      ...a,
                      [selected]: { ...selectedAppearance, roughness: v },
                    }))
                  }
                />
                <Slider
                  label="Wet coat"
                  value={selectedAppearance.clearcoat}
                  min={0}
                  max={1}
                  step={0.01}
                  onStart={() => beginEdit("Wet coat")}
                  onEnd={endEdit}
                  onChange={(v) =>
                    setAppearance((a) => ({
                      ...a,
                      [selected]: { ...selectedAppearance, clearcoat: v },
                    }))
                  }
                />
                <p className="field-note">
                  Procedural PBR material. Optical properties are design values,
                  not measured tissue.
                </p>
              </Section>
              <Section title="Visibility">
                <Slider
                  label="Opacity"
                  value={Math.round(selectedAppearance.opacity * 100)}
                  min={10}
                  max={100}
                  unit="%"
                  onStart={() => beginEdit("Material opacity")}
                  onEnd={endEdit}
                  onChange={(v) =>
                    setAppearance((a) => ({
                      ...a,
                      [selected]: { ...selectedAppearance, opacity: v / 100 },
                    }))
                  }
                />
                <button
                  className={`toggle-row ${selectedAppearance.wireframe ? "enabled" : ""}`}
                  onClick={() =>
                    setAppearance((a) => ({
                      ...a,
                      [selected]: {
                        ...selectedAppearance,
                        wireframe: !selectedAppearance.wireframe,
                      },
                    }))
                  }
                >
                  <span>Wireframe surface</span>
                  <span className="toggle-switch" />
                </button>
              </Section>
            </>
          )}
          {tab === "inspect" && (
            <>
              <Section title="Provenance">
                <div className="evidence-row">
                  <span>Construction</span>
                  <strong>Procedural</strong>
                </div>
                <div className="evidence-row">
                  <span>Expert review</span>
                  <strong className="amber">Pending</strong>
                </div>
                <div className="evidence-row">
                  <span>Coordinate system</span>
                  <strong>RAS+ · mm</strong>
                </div>
                <div className="evidence-row">
                  <span>Geometry</span>
                  <strong>Surface mesh</strong>
                </div>
                <div className="evidence-row">
                  <span>Physics validation</span>
                  <strong className="muted">Not run</strong>
                </div>
                <div className="evidence-row">
                  <span>Learned generation</span>
                  <strong className="muted">
                    {scene?.metadata?.generation_source ===
                    "experimental_conditional_parameter_flow"
                      ? "Parameter flow pilot"
                      : "Not active"}
                  </strong>
                </div>
                <p className="field-note">
                  A development asset for building an original dataset.
                  Appearance and numerical checks do not establish clinical or
                  anatomical validity.
                </p>
              </Section>
              <Section title="Mesh measurements">
                <div className="evidence-row">
                  <span>Vertices</span>
                  <strong>{metric?.vertices.toLocaleString()}</strong>
                </div>
                <div className="evidence-row">
                  <span>Triangles</span>
                  <strong>{metric?.triangles.toLocaleString()}</strong>
                </div>
                <div className="evidence-row">
                  <span>Surface area</span>
                  <strong>{metric?.areaCm2.toFixed(1)} cm²</strong>
                </div>
                <div className="evidence-row">
                  <span>Enclosed volume</span>
                  <strong>{metric?.volumeMl.toFixed(1)} mL</strong>
                </div>
              </Section>
              <Section title="Change log">
                {events.slice(0, 8).map((e, i) => (
                  <div className="event" key={i}>
                    <span />
                    {e}
                  </div>
                ))}
              </Section>
            </>
          )}
          <Section title="Section & camera">
            <button
              className={`toggle-row ${clip !== null ? "enabled" : ""}`}
              onClick={() => setClip((v) => (v === null ? 0 : null))}
            >
              <span>Clipping plane</span>
              <span className="toggle-switch" />
            </button>
            {clip !== null && (
              <Slider
                label="Plane offset"
                value={clip}
                min={-150}
                max={150}
                unit="mm"
                onChange={setClip}
              />
            )}
            <div className="camera-presets">
              {(["anterior", "superior", "posterior", "oblique"] as const).map(
                (p) => (
                  <button key={p} onClick={() => viewport.current?.camera(p)}>
                    {p[0]!.toUpperCase() + p.slice(1)}
                  </button>
                ),
              )}
            </div>
          </Section>
        </div>
        <div className="inspector-footer">
          <span className="status-dot" />
          Local surface guards<span>ACTIVE</span>
        </div>
      </aside>
      <footer className="statusbar">
        <div>
          <span className="live-dot" />
          WebGL2
          <span className="status-sep" />
          {stats.fps} fps
          <span className="status-sep" />
          {stats.triangles.toLocaleString()} triangles
        </div>
        <div>
          <span>RAS+</span>
          <span className="status-sep" />
          millimetres
          <span className="status-sep" />
          <button onClick={() => setShowHistory((v) => !v)}>
            <History size={12} />
            {past.length} edits
          </button>
          <span className="status-sep" />
          <button onClick={() => setHelpOpen(true)}>
            Shortcuts <kbd>?</kbd>
          </button>
        </div>
      </footer>
      {notice && (
        <div className="toast" role="status">
          <Check size={15} />
          <span>{notice}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {showHistory && (
        <div className="history-panel">
          <div className="panel-top">
            <span>EDIT HISTORY</span>
            <IconButton
              title="Close history"
              onClick={() => setShowHistory(false)}
            >
              <X size={14} />
            </IconButton>
          </div>
          {events.map((e, i) => (
            <div className="event" key={i}>
              <span />
              {e}
            </div>
          ))}
          <div className="history-buttons">
            <Button onClick={undo} disabled={!past.length}>
              <Undo2 size={13} />
              Undo
            </Button>
            <Button onClick={redo} disabled={!future.length}>
              <Redo2 size={13} />
              Redo
            </Button>
          </div>
        </div>
      )}
      {helpOpen && (
        <div className="modal-backdrop" onClick={() => setHelpOpen(false)}>
          <div
            className="help-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Workspace guide"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2>Your anatomy workspace</h2>
              <IconButton
                title="Close guide"
                onClick={() => setHelpOpen(false)}
              >
                <X size={18} />
              </IconButton>
            </div>
            <p>
              Original meshes, direct surface editing and traceable specimen
              variations.
            </p>
            <div className="shortcut-grid">
              {tools.map((t) => (
                <div key={t.id}>
                  <span>{t.label}</span>
                  <kbd className="keyhint">{t.key}</kbd>
                </div>
              ))}
              <div>
                <span>Fit anatomy</span>
                <kbd className="keyhint">F</kbd>
              </div>
              <div>
                <span>Undo / redo</span>
                <kbd className="keyhint">⌘Z / ⌘⇧Z</kbd>
              </div>
              <div>
                <span>Save project</span>
                <kbd className="keyhint">⌘S</kbd>
              </div>
              <div>
                <span>Navigate / dismiss</span>
                <kbd className="keyhint">Esc</kbd>
              </div>
            </div>
            <div className="capability-callout">
              <ShieldCheck size={19} />
              <p>
                <strong>Development preview</strong>These are original
                procedural assets awaiting expert review. Editing checks local
                surface triangles; it does not verify internal anatomy,
                collision-free geometry or human biomechanics. The probe is a
                tetrahedral XPBD displacement preview with a heuristic
                spring/volume model; it is not calibrated tissue mechanics. Text
                requests are compiled into supported typed changes.
              </p>
            </div>
            <Button primary onClick={() => setHelpOpen(false)}>
              Back to specimen <ArrowRight size={14} />
            </Button>
          </div>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".json"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importProject(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
