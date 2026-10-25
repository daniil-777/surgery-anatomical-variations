import { jointModelName, modelMessage } from "./modelNames";
import { apiGet, apiUrl } from "./api";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowRight, Check, ChevronDown, Cpu, Layers3, LoaderCircle, Sparkles, X } from "lucide-react";
import { atlasError } from "./atlas";

interface JointVersion {
  generation: 1 | 2;
  bundle_sha256: string;
  active: boolean;
  integrity: string;
  conditions?: number;
  runtime?: { gpu?: string | null; device?: string };
}

interface History {
  versions: JointVersion[];
  selection_error: string | null;
}

const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const versionKey = (version: JointVersion) => `${version.generation}:${version.bundle_sha256}`;

function readHistory(value: unknown): History {
  const data = value as Record<string, unknown> | null;
  if (!data || !Array.isArray(data.versions) ||
    (data.selected_generation !== null && data.selected_generation !== 1 && data.selected_generation !== 2) ||
    (data.active_bundle !== null && !isHash(data.active_bundle)) ||
    (data.selection_error !== null && typeof data.selection_error !== "string")) {
    throw new Error("The model service returned an invalid model list.");
  }
  const versions = data.versions as JointVersion[];
  if (versions.some(version => !version || (version.generation !== 1 && version.generation !== 2) ||
    !isHash(version.bundle_sha256) || typeof version.active !== "boolean" || typeof version.integrity !== "string" ||
    (version.conditions !== undefined && (!Number.isInteger(version.conditions) || version.conditions < 0)) ||
    (version.runtime !== undefined && (!version.runtime || typeof version.runtime !== "object" ||
      (version.runtime.gpu !== undefined && version.runtime.gpu !== null && typeof version.runtime.gpu !== "string") ||
      (version.runtime.device !== undefined && typeof version.runtime.device !== "string"))))) {
    throw new Error("The model service returned invalid model information.");
  }
  if (new Set(versions.map(versionKey)).size !== versions.length) throw new Error("The model list contains duplicate versions.");
  const active = versions.filter(version => version.active);
  if (active.length > 1 || active.some(version => version.integrity !== "verified" ||
    version.generation !== data.selected_generation || version.bundle_sha256 !== data.active_bundle) ||
    (data.active_bundle !== null && !data.selection_error && active.length !== 1)) {
    throw new Error("The active model could not be verified.");
  }
  return {
    versions: [...versions].sort((a, b) => b.generation - a.generation ||
      Number(Boolean(b.runtime?.gpu)) - Number(Boolean(a.runtime?.gpu)) || a.bundle_sha256.localeCompare(b.bundle_sha256)),
    selection_error: data.selection_error as string | null,
  };
}

function trainingHardware(version: JointVersion): string {
  const gpu = version.runtime?.gpu?.trim();
  if (gpu) {
    if (/\bA100\b/i.test(gpu)) return "A100";
    if (/\bT4\b/i.test(gpu)) return "T4";
    return gpu.replace(/^(NVIDIA|Tesla)\s+/i, "");
  }
  return version.runtime?.device === "cpu" ? "CPU" : "Unknown training";
}

function modelLabel(version: JointVersion): string {
  return `${jointModelName(version.generation)} · ${trainingHardware(version)}`;
}

function verifyActivation(value: unknown, selected: JointVersion): void {
  const status = value as { joint_generation?: unknown; joint_bundle_sha256?: unknown; lanes?: { joint?: { status?: unknown } } } | null;
  if (!status || status.joint_generation !== selected.generation || status.joint_bundle_sha256 !== selected.bundle_sha256 || status.lanes?.joint?.status !== "active") {
    throw new Error("The service did not confirm the selected model. Refresh the list to check the active version.");
  }
}

interface Props {
  disabled: boolean;
  revision: number;
  onBusyChange: (busy: boolean) => void;
  onActivated: (available: boolean, generation: 1 | 2) => void | Promise<void>;
  onManage: (trigger: HTMLButtonElement | null) => void;
}

export function AtlasModelSelector({ disabled, revision, onBusyChange, onActivated, onManage }: Props) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const request = useRef(0);
  const historyController = useRef<AbortController | null>(null);
  const activating = useRef(false);
  const needsStudioSync = useRef(false);
  const callbacks = useRef({ onBusyChange, onActivated });
  callbacks.current = { onBusyChange, onActivated };
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<JointVersion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const busy = pending !== null;
  const active = versions.find(version => version.active && version.integrity === "verified");

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) trigger.current?.focus();
  }, []);

  const refresh = useCallback(async () => {
    if (activating.current) return;
    historyController.current?.abort();
    const controller = new AbortController();
    historyController.current = controller;
    const sequence = ++request.current;
    setLoading(true);
    setError("");
    try {
      const response = await apiGet("/api/atlas/models/joint/history", { signal: controller.signal }, "atlas/models/joint/history.json");   // the public copy carries the API's list
      if (!response.ok) throw await atlasError(response);
      const history = readHistory(await response.json());
      if (!mounted.current || sequence !== request.current) return;
      const verifiedActive = history.versions.find(version => version.active && version.integrity === "verified");
      // A committed activation can outlive a failed response or catalog refresh.
      // Reconcile the controls with verified history before clearing that error.
      if (needsStudioSync.current && verifiedActive) {
        activating.current = true;
        callbacks.current.onBusyChange(true);
        try {
          await callbacks.current.onActivated(true, verifiedActive.generation);
          needsStudioSync.current = false;
        } finally {
          activating.current = false;
          if (mounted.current) callbacks.current.onBusyChange(false);
        }
        if (!mounted.current || sequence !== request.current) return;
      }
      setVersions(history.versions);
      setLoaded(true);
      setStale(false);
      if (history.selection_error) setError("The saved default is unavailable. Choose a verified model below.");
    } catch (cause) {
      if (!mounted.current || controller.signal.aborted || sequence !== request.current) return;
      setStale(true);
      setError(cause instanceof Error ? cause.message : "The model list is unavailable. Please retry.");
    } finally {
      if (mounted.current && sequence === request.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      historyController.current?.abort();
      request.current++;
      if (activating.current) callbacks.current.onBusyChange(false);
    };
  }, []);

  useEffect(() => { void refresh(); }, [revision, refresh]);
  useEffect(() => {
    if (!open) return;
    void refresh();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open, close, refresh]);

  useEffect(() => {
    if (!open || loading) return;
    // Do not steal focus on a retry once the user is already inside the panel.
    if (document.activeElement !== trigger.current && root.current?.contains(document.activeElement)) return;
    const initial = list.current?.querySelector<HTMLButtonElement>("[data-active='true']:not(:disabled)") ??
      list.current?.querySelector<HTMLButtonElement>("[data-model-option]:not(:disabled)") ??
      root.current?.querySelector<HTMLButtonElement>(".atlas-model-picker-popover button:not(:disabled)");
    initial?.focus();
  }, [open, loading, versions]);

  useEffect(() => { if (disabled) close(false); }, [disabled, close]);

  const activate = async (selected: JointVersion) => {
    if (disabled || activating.current || loading || stale || selected.active || selected.integrity !== "verified") return;
    activating.current = true;
    historyController.current?.abort();
    request.current++;
    setPending(versionKey(selected));
    setError("");
    callbacks.current.onBusyChange(true);
    let confirmed = false;
    try {
      const response = await fetch(apiUrl("/api/atlas/models/joint/activate"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generation: selected.generation, bundle_sha256: selected.bundle_sha256 }),
      });
      if (!response.ok) throw await atlasError(response);
      verifyActivation(await response.json(), selected);
      confirmed = true;
      if (!mounted.current) return;
      setVersions(previous => previous.map(version => ({ ...version, active: versionKey(version) === versionKey(selected) })));
      setStale(false);
      await callbacks.current.onActivated(true, selected.generation);
      needsStudioSync.current = false;
      if (mounted.current) close();
    } catch (cause) {
      if (!mounted.current) return;
      needsStudioSync.current = true;
      setStale(!confirmed);
      setError(confirmed ? "The model is active, but Studio could not refresh its controls. Reopen the model list or refresh Studio." :
        cause instanceof Error ? cause.message : "The model could not be selected. Retry to check the active version.");
    } finally {
      activating.current = false;
      if (mounted.current) {
        setPending(null);
        callbacks.current.onBusyChange(false);
      }
    }
  };

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const options = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-model-option]:not(:disabled)") ?? [])];
    if (!options.length || !(event.target instanceof HTMLButtonElement) || !options.includes(event.target)) return;
    const index = options.indexOf(event.target);
    const next = event.key === "ArrowDown" ? (index + 1) % options.length : event.key === "ArrowUp" ?
      (index + options.length - 1) % options.length : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : null;
    if (next !== null) { event.preventDefault(); options[next]?.focus(); }
  };

  return <div className="atlas-model-picker" ref={root}>
    <button ref={trigger} type="button" className={`atlas-model-picker-trigger${open ? " is-open" : ""}`} aria-label="Choose generation model"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-popover`} disabled={disabled}
      onClick={() => { if (open) close(); else { setLoading(true); setOpen(true); } }}>
      <span className="atlas-model-picker-icon">{busy ? <LoaderCircle size={18} className="atlas-spinning" /> : <Layers3 size={18} />}</span>
      <span className="atlas-model-picker-trigger-copy"><small>{stale ? "Model status unavailable" : "Generation model"}</small>
        <strong>{active ? modelLabel(active) : !loaded && loading ? "Checking models…" : "Choose a model"}</strong></span>
      <ChevronDown size={15} className="atlas-model-picker-chevron" />
    </button>
    {open && <div id={`${id}-popover`} className="atlas-model-picker-popover" role="dialog" aria-label="Generation models" aria-busy={loading || busy}>
      <div className="atlas-model-picker-heading"><div><span>YOUR TRAINED MODELS</span><h2>Choose a model</h2></div>
        <button type="button" aria-label="Close model selector" onClick={() => close()}><X size={17} /></button></div>
      <div className="atlas-model-picker-list" ref={list} onKeyDown={navigate}>
        {versions.map(version => {
          const key = versionKey(version), available = version.integrity === "verified";
          return <button key={key} type="button" data-model-option data-active={version.active}
            className={`atlas-model-picker-option${version.active ? " is-active" : ""}${!available ? " is-unavailable" : ""}`}
            aria-label={`Use ${modelLabel(version)}`} aria-pressed={version.active && !stale}
            disabled={disabled || busy || loading || stale || !available} onClick={() => void activate(version)}>
            <span className="atlas-model-picker-option-icon">{pending === key ? <LoaderCircle size={20} className="atlas-spinning" /> : version.generation === 2 ? <Sparkles size={20} /> : <Cpu size={20} />}</span>
            <span className="atlas-model-picker-option-copy"><strong>{modelLabel(version)}</strong>
              <small>{version.generation === 2 ? "Expanded disease ranges" : "Original joint variations"}{version.conditions ? ` · ${version.conditions} conditions` : ""}</small>
              <span>{trainingHardware(version) === "Unknown training" ? "Training hardware unavailable" : `Trained on ${trainingHardware(version)}`} · {version.bundle_sha256.slice(0, 8)}</span></span>
            <span className="atlas-model-picker-badge">{!available ? "Unavailable" : pending === key ? "Activating…" : version.active ? <><Check size={13} />{stale ? "Last active" : "Active"}</> : <ArrowRight size={15} />}</span>
          </button>;
        })}
      </div>
      {loading && <p className="atlas-model-picker-note" role="status"><LoaderCircle size={14} className="atlas-spinning" /> Checking saved models…</p>}
      {!loading && !versions.length && !error && <div className="atlas-model-picker-empty"><Layers3 size={24} /><strong>No imported joint models yet</strong><p>Import a model weights ZIP to start generating variations.</p></div>}
      {error && <div className="atlas-model-picker-error" role="alert"><span>{modelMessage(error)}</span><button type="button" disabled={busy || loading || disabled} onClick={() => void refresh()}>Retry</button></div>}
      <p className="atlas-model-picker-note">Switching sets the default for your next joint variation. A100, T4 and CPU identify training hardware.</p>
      <button type="button" className="atlas-model-picker-manage" disabled={busy || loading || disabled} onClick={() => { close(false); onManage(trigger.current); }}>Manage weights & imports <ArrowRight size={15} /></button>
    </div>}
  </div>;
}
