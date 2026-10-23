import { DisplaySettings } from "./DisplaySettings";
import { apiUrl } from "./api";
import { useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Upload, X } from "lucide-react";
import { atlasError } from "./atlas";

interface ModelStatus {
  source: "defaults" | "imported";
  bundle_sha256: string | null;
  lanes: Record<string, { status: string; scope: string; source?: "bundled_default" | "imported" | "unavailable"; method?: string; groups?: { organ: string; disease_code: string }[] }>;
  max_upload_bytes: number;
  language_enabled?: boolean;
  joint_bundle_sha256?: string | null;
  wording_bundle_sha256?: string | null;
  joint_generation?: 1 | 2;
}

interface JointVersion { generation: 1 | 2; bundle_sha256: string; active: boolean; integrity: string; method?: string; runtime?: { gpu?: string | null; device?: string } }

function readStatus(value: unknown): ModelStatus {
  const v = value as Partial<ModelStatus> | null;
  if (!v || !["defaults", "imported"].includes(String(v.source)) || !v.lanes || typeof v.lanes !== "object" ||
    typeof v.max_upload_bytes !== "number" || !Number.isFinite(v.max_upload_bytes) || v.max_upload_bytes <= 0 ||
    (v.language_enabled !== undefined && typeof v.language_enabled !== "boolean") ||
    (v.joint_generation !== undefined && v.joint_generation !== 1 && v.joint_generation !== 2) ||
    (v.joint_bundle_sha256 != null && (typeof v.joint_bundle_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.joint_bundle_sha256))) ||
    (v.wording_bundle_sha256 != null && (typeof v.wording_bundle_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.wording_bundle_sha256))) ||
    (v.bundle_sha256 !== null && (typeof v.bundle_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.bundle_sha256))) ||
    Object.values(v.lanes).some(lane => !lane || typeof lane.status !== "string" || typeof lane.scope !== "string" || (lane.method !== undefined && typeof lane.method !== "string") || (lane.groups !== undefined && (!Array.isArray(lane.groups) || lane.groups.some(group => !group || typeof group.organ !== "string" || typeof group.disease_code !== "string")))))
    throw new Error("The model service returned invalid status information.");
  return v as ModelStatus;
}

const friendly: Record<string, string> = {
  active: "Active", available: "Available", unavailable: "Unavailable", not_included: "Not included",
  stored_retrieval_prior: "Stored · case retrieval", stored_research_adapter_not_enabled: "Stored · research only", not_trained: "Not trained",
  enabled_guarded_adapter: "Enabled · compiler guarded",
};

export function AtlasModelsPanel({ onClose, onLanguageState, onJointState }: { onClose: () => void; onLanguageState: (enabled: boolean, explicitlySelected?: boolean) => void; onJointState?: (available: boolean, generation?: 1 | 2) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [pendingAction, setPendingAction] = useState<"import" | "restore" | "language" | "clinical" | "version" | null>(null);
  const [versions, setVersions] = useState<JointVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState("");
  const historyRequest = useRef(0);
  const busy = pendingAction !== null;
  const importedWeights = status?.source === "imported" || Boolean(status?.wording_bundle_sha256) || Boolean(status?.joint_bundle_sha256 && status.lanes.joint?.source !== "bundled_default");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const loadingLanguage = pendingAction === "language";
  const [clinicalGroup, setClinicalGroup] = useState(0);
  const [clinicalCase, setClinicalCase] = useState<{ id: string; organ: string; patients: number; organVolume: number; lesionVolume: number } | null>(null);
  const refreshVersions = async () => {
    const request = ++historyRequest.current;
    const response = await fetch(apiUrl("/api/atlas/models/joint/history"));
    if (!response.ok) return;
    const value = await response.json();
    if (request !== historyRequest.current) return;
    if (!Array.isArray(value.versions) || value.versions.some((v: JointVersion) => !v || ![1, 2].includes(v.generation) || !/^[a-f0-9]{64}$/.test(v.bundle_sha256) || typeof v.active !== "boolean" || typeof v.integrity !== "string")) return;
    setVersions(value.versions);
    setSelectedVersion(previous => {
      // A status refresh can finish after the user chooses a retained model.
      // Keep that choice; otherwise the activation button becomes disabled again.
      const rows = value.versions as JointVersion[];
      if (rows.some(v => v.integrity === "verified" && `${v.generation}:${v.bundle_sha256}` === previous)) return previous;
      const next = rows.find(v => v.active && v.integrity === "verified") ?? rows.find(v => v.integrity === "verified");
      return next ? `${next.generation}:${next.bundle_sha256}` : "";
    });
  };
  const updateStatus = (value: unknown, explicitlySelected = false) => { const next = readStatus(value); setStatus(next); setClinicalCase(null); setClinicalGroup(0); onLanguageState(next.language_enabled === true && !next.wording_bundle_sha256, explicitlySelected); onJointState?.(next.lanes.joint?.status === "active" && Boolean(next.joint_bundle_sha256), next.joint_generation ?? 1); void refreshVersions().catch(() => {}); };
  useEffect(() => {
    dialog.current?.showModal();
    const controller = new AbortController();
    // Retained versions are also a recovery path if the active bundle is damaged.
    void refreshVersions().catch(() => {});
    void fetch(apiUrl("/api/atlas/models"), { signal: controller.signal }).then(async response => {
      if (!response.ok) throw await atlasError(response);
      updateStatus(await response.json());
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Model status is unavailable."); });
    return () => { controller.abort(); historyRequest.current++; };
  }, []);
  const change = async (restore = false) => {
    if (busy || (!restore && !file)) return;
    const limit = status?.max_upload_bytes ?? 128 * 1024 * 1024;
    if (!restore && file && (file.size === 0 || file.size > limit || !file.name.toLowerCase().endsWith(".zip"))) {
      setError(`Choose a nonempty Colab weights ZIP smaller than ${Math.round(limit / 1024 / 1024)} MiB.`); return;
    }
    setPendingAction(restore ? "restore" : "import"); setError(""); setMessage("");
    try {
      const response = await fetch(apiUrl(`/api/atlas/models/${restore ? "defaults" : "import"}`), {
        method: "POST", headers: { "Content-Type": restore ? "application/json" : "application/zip" },
        body: restore ? "{}" : file,
      });
      if (!response.ok) throw await atlasError(response);
      updateStatus(await response.json());
      setMessage(restore ? "Default models restored. Your displayed organ is unchanged." : "Weights validated and activated. Joint models power variation controls; wording models power the text box. Check this panel for the active models.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The model change failed. The previous models remain active."); }
    finally { setPendingAction(null); }
  };
  const enableLanguage = async () => {
    if (busy) return;
    setPendingAction("language"); setError(""); setMessage("");
    try {
      const response = await fetch(apiUrl("/api/atlas/models/language/enable"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allow_model_download: true }) });
      if (!response.ok) throw await atlasError(response);
      updateStatus(await response.json(), true);
      setMessage("Text adapter enabled. The text box now offers trained shape instructions with compiler validation.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The text adapter could not be enabled."); }
    finally { setPendingAction(null); }
  };
  const retrieveCase = async () => {
    const group = status?.lanes.clinical?.groups?.[clinicalGroup];
    if (busy || !group) return;
    setPendingAction("clinical"); setError(""); setClinicalCase(null);
    try {
      const response = await fetch(apiUrl("/api/atlas/models/clinical/sample"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...group, seed: 42 }) });
      if (!response.ok) throw await atlasError(response);
      const result = await response.json(); const item = result.cases?.[0];
      if (!item || typeof item.case_id !== "string" || item.organ !== group.organ || item.disease_code !== group.disease_code || item.sampling !== "empirical_case_retrieval" || !Number.isInteger(item.observed_training_patients) || !Number.isFinite(item.measured_features?.organ_volume_ml) || !Number.isFinite(item.measured_features?.lesion_volume_ml)) throw new Error("The source prior returned an invalid observed case.");
      setClinicalCase({ id: item.case_id, organ: item.organ, patients: item.observed_training_patients, organVolume: item.measured_features.organ_volume_ml, lesionVolume: item.measured_features.lesion_volume_ml });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Observed-case retrieval failed."); }
    finally { setPendingAction(null); }
  };
  const activateVersion = async () => {
    const selected = versions.find(version => `${version.generation}:${version.bundle_sha256}` === selectedVersion);
    if (busy || !selected || selected.integrity !== "verified") return;
    setPendingAction("version"); setError(""); setMessage("");
    try {
      const response = await fetch(apiUrl("/api/atlas/models/joint/activate"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ generation: selected.generation, bundle_sha256: selected.bundle_sha256 }) });
      if (!response.ok) throw await atlasError(response);
      updateStatus(await response.json());
      setMessage("Selected model activated. Every previous model remains stored. Generate a new joint variation to use this version.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Model selection failed; the previous version remains active."); }
    finally { setPendingAction(null); }
  };
  return <dialog className="atlas-model-dialog" ref={dialog} aria-labelledby="atlas-models-title" onClose={onClose} onCancel={event => { if (busy) event.preventDefault(); }}>
    <div className="atlas-model-dialog-heading"><div><span>COLAB → STUDIO</span><h2 id="atlas-models-title">Trained models</h2></div><DisplaySettings includeAccount={false} /><button aria-label="Close trained models" disabled={busy} onClick={() => dialog.current?.close()}><X size={18} /></button></div>
    <p>Load the weight ZIP from a completed Colab run. Studio verifies its data, decoder and reference geometry before activation. Previous model versions remain stored and can be selected below.</p>
    <div className="atlas-model-source"><span className={importedWeights ? "imported" : ""} />{status ? importedWeights ? "Your imported weights are active" : "Packaged default models" : "Checking model status…"}</div>
    {status && <dl className="atlas-model-lanes">{Object.entries(status.lanes).map(([name, lane]) => <div key={name}><dt>{name}</dt><dd><strong>{friendly[lane.status] ?? lane.status}{lane.method ? ` · ${lane.method}` : ""}</strong><small>{lane.scope}</small></dd></div>)}</dl>}
    {status?.bundle_sha256 && <p className="atlas-model-hash">Bundle SHA256 <code>{status.bundle_sha256}</code></p>}
    {status?.joint_bundle_sha256 && <p className="atlas-model-hash">Joint model bundle SHA256 <code>{status.joint_bundle_sha256}</code></p>}
    {status?.wording_bundle_sha256 && <p className="atlas-model-hash">Wording model bundle SHA256 <code>{status.wording_bundle_sha256}</code></p>}
    {versions.length > 0 && <section className="atlas-clinical-cases"><h3>Preserved joint models</h3><label>Model version <select aria-label="Preserved joint model" value={selectedVersion} disabled={busy} onChange={event => setSelectedVersion(event.target.value)}>{versions.map(version => <option key={`${version.generation}:${version.bundle_sha256}`} value={`${version.generation}:${version.bundle_sha256}`} disabled={version.integrity !== "verified"}>{version.generation === 2 ? "Spline flow v2" : "Joint VAE v1"} · {version.runtime?.gpu ?? "CPU"} · {version.bundle_sha256.slice(0, 12)}{version.active ? " · active" : ""}{version.integrity !== "verified" ? " · damaged" : ""}</option>)}</select></label><button className="atlas-btn" disabled={busy || !selectedVersion || versions.some(version => version.active && `${version.generation}:${version.bundle_sha256}` === selectedVersion)} onClick={() => void activateVersion()}>{pendingAction === "version" ? "Validating retained model…" : "Use selected version"}</button></section>}
    {status?.lanes.clinical?.groups?.length ? <details className="atlas-clinical-cases"><summary>Observed clinical cases</summary><p>Read-only retrieval from the measured training cases. This does not modify the organ in the editor.</p><label>Source group <select aria-label="Clinical source group" value={clinicalGroup} disabled={busy} onChange={event => { setClinicalGroup(Number(event.target.value)); setClinicalCase(null); }}>{status.lanes.clinical.groups.map((group, index) => <option key={`${group.organ}|${group.disease_code}`} value={index}>{group.organ} · {group.disease_code.replaceAll("_", " ")}</option>)}</select></label><button className="atlas-btn" disabled={busy} onClick={() => void retrieveCase()}>{pendingAction === "clinical" ? "Retrieving observed case…" : "Retrieve observed case"}</button>{clinicalCase && <p role="status"><strong>{clinicalCase.id}</strong><br />{clinicalCase.organ} · organ {clinicalCase.organVolume.toFixed(1)} mL · lesion {clinicalCase.lesionVolume.toFixed(1)} mL<br />{clinicalCase.patients} observed training patient{clinicalCase.patients === 1 ? "" : "s"} in this group; no population variance is inferred.</p>}</details> : null}
    {status?.source === "imported" && !status.wording_bundle_sha256 && status.lanes.language && status.lanes.language.status !== "not_included" && <section className="atlas-language-enable"><p>The optional legacy text adapter proposes shape edits. Contextual disease and appearance edits remain available through the built-in compiler. The first enable may download the pinned Qwen base model (about 1 GB). Every proposal passes validation before application.</p><button className="atlas-btn" disabled={busy || status.language_enabled} onClick={() => void enableLanguage()}>{loadingLanguage ? <LoaderCircle size={15} className="atlas-spinning" /> : null}{status.language_enabled ? "Text adapter enabled" : loadingLanguage ? "Loading text model…" : "Enable text adapter (downloads base model)"}</button></section>}
    <label className="atlas-model-file"><Upload size={18} /><span>Colab weight archive<input type="file" accept=".zip,application/zip" disabled={busy} aria-label="Colab weight archive" onChange={event => { setFile(event.target.files?.[0] ?? null); setError(""); setMessage(""); }} /></span></label>
    <p className="atlas-model-scope">Joint variation samples shape, tissue color and the selected disease together. A separate wording model translates contextual text into validated shape, appearance and disease edits. Without wording weights, the built-in compiler handles supported phrases. Joint weight archives do not train text understanding or tissue physics.</p>
    {error && <p className="atlas-model-error" role="alert">{error}</p>}
    {message && <p className="atlas-model-success" role="status"><Check size={15} />{message}</p>}
    <div className="atlas-model-actions"><button className="atlas-btn" disabled={busy || (status ? status.source !== "imported" && !status.joint_bundle_sha256 && !status.wording_bundle_sha256 : !error)} onClick={() => void change(true)}>{pendingAction === "restore" ? "Restoring defaults…" : "Restore defaults"}</button><button className="atlas-btn atlas-export" disabled={busy || !file} onClick={() => void change()}>{pendingAction === "import" ? <LoaderCircle size={15} className="atlas-spinning" /> : <Upload size={15} />}{pendingAction === "import" ? "Validating models…" : "Validate & activate"}</button></div>
  </dialog>;
}
