import { appearanceModelLabel, modelMessage } from "../modelNames";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { publicUrl } from "../api";
import { DEFAULT_COLAB_APPEARANCE_MODELS, discoverColabCatalog, selectBestColabAppearanceModel, type ColabAppearanceModelEntry } from "./colabModels";
import { MAX_MODEL_FILE_BYTES, parseAppearanceModel, type AppearanceModel } from "./neuralAppearance";
import { bakeAppearanceInWorker, type AppearanceBake } from "./neuralAppearanceClient";
import { readStoredAppearance, removeStoredAppearance, storeAppearance } from "./appearanceStorage";
import { newMaterialSeed } from "./materialVariation";

export interface NeuralSurfaceAppearance {
  texture: THREE.Texture;
  condition: string;
  modelId: string;
  resolution: number;
  evidence: string;
  region: string;
  seed: string;
}
interface Props { region: string; suspended?: boolean; onChange: (appearance: NeuralSurfaceAppearance | undefined) => void }

export function NeuralAppearancePanel({ region, suspended = false, onChange }: Props) {
  const [model, setModel] = useState<AppearanceModel>(), [source, setSource] = useState("");
  const [seed, setSeed] = useState("42"), [condition, setCondition] = useState(0), [resolution, setResolution] = useState(256);
  const [enabled, setEnabled] = useState(true), [status, setStatus] = useState(""), [error, setError] = useState("");
  const [bake, setBake] = useState<AppearanceBake>(), [appearance, setAppearance] = useState<NeuralSurfaceAppearance>();
  const [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  const [colabModels, setColabModels] = useState<readonly ColabAppearanceModelEntry[]>(DEFAULT_COLAB_APPEARANCE_MODELS);
  const [selectedColabId, setSelectedColabId] = useState<string>(DEFAULT_COLAB_APPEARANCE_MODELS[0]!.id);
  const [loadingColab, setLoadingColab] = useState(false);
  const callback = useRef(onChange); callback.current = onChange;
  const operation = useRef<AbortController | undefined>(undefined), revision = useRef(0), mounted = useRef(true);
  const labels = model?.artifact.architecture.condition_labels ?? [];
  const regions = model?.artifact.architecture.condition_regions ?? [];
  const matching = regions.map((name, index) => name === region ? index : -1).filter(index => index >= 0);
  const selectedCondition = matching.includes(condition) ? condition : matching[0];

  useEffect(() => {
    mounted.current = true;
    const version = revision.current;
    const catalogController = new AbortController();
    void discoverColabCatalog(catalogController.signal).then(catalog => {
      if (!mounted.current) return;
      setColabModels(catalog.appearance_models);
      const best = selectBestColabAppearanceModel(catalog.appearance_models, region);
      if (best) setSelectedColabId(best.id);
    });
    void readStoredAppearance().then(async stored => {
      if (!stored) return;
      const loaded = await parseAppearanceModel(stored);
      if (mounted.current && revision.current === version) { setModel(loaded); setSource(stored); setStatus("Restored verified model from this browser."); }
    }).catch(() => { /* Browser storage is optional; importing still works for this session. */ });
    return () => { mounted.current = false; catalogController.abort(); operation.current?.abort(); };
  }, []);

  useEffect(() => () => appearance?.texture.dispose(), [appearance]);
  useEffect(() => { callback.current(!suspended && enabled && appearance?.region === region ? appearance : undefined); }, [appearance, enabled, region, suspended]);

  useEffect(() => {
    operation.current?.abort(); setAppearance(undefined); setBake(undefined);
    if (!source || !model || selectedCondition === undefined || !enabled || suspended) { setBusy(false); return; }
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(""); setStatus("Preparing a surface-bound appearance…");
    const timer = setTimeout(() => {
      void bakeAppearanceInWorker(source, selectedCondition, seed, resolution, controller.signal, fraction => {
        if (!controller.signal.aborted) setStatus(`Generating appearance · ${Math.round(fraction * 100)}%`);
      }).then(result => {
        if (controller.signal.aborted) return;
        const texture = new THREE.DataTexture(result.rgba, resolution, resolution, THREE.RGBAFormat);
        // CPU rows follow PNG top-to-bottom coordinates, matching existing TextureLoader maps.
        texture.flipY = true; texture.colorSpace = THREE.SRGBColorSpace;
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter; texture.magFilter = THREE.LinearFilter; texture.needsUpdate = true;
        setBake(result); setAppearance({ texture, region, seed, condition: labels[selectedCondition]!, modelId: result.modelId,
          resolution, evidence: String(model.artifact.provenance.training_status) });
        const detail = model.kind === "spatial" ? `, sampled from ${model.artifact.architecture.native_resolution.join(" × ")} native output` : "";
        setStatus(`Applied ${resolution}² learned RGB${detail} in ${(result.durationMs / 1000).toFixed(1)} s. Surface relief remains authored.`);
      }).catch(reason => {
        if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : String(reason)); setStatus(""); }
      }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [source, model, selectedCondition, seed, resolution, region, enabled, retry, suspended]);

  const loadColabModel = async (preferredId?: string) => {
    const version = ++revision.current;
    setLoadingColab(true);
    setError("");
    setStatus("Checking available generative models…");
    try {
      const catalog = await discoverColabCatalog();
      if (!mounted.current || version !== revision.current) return;
      setColabModels(catalog.appearance_models);
      const chosen = selectBestColabAppearanceModel(catalog.appearance_models, region, preferredId);
      if (!chosen) throw new Error("No generative models were found.");
      setSelectedColabId(chosen.id);
      setStatus(`Loading ${appearanceModelLabel(chosen)}…`);
      const response = await fetch(publicUrl(chosen.path), { cache: "no-store" });
      if (!response.ok) throw new Error(`Generative model unavailable: HTTP ${response.status}`);
      const text = await response.text();
      const loaded = await parseAppearanceModel(text);
      if (!mounted.current || version !== revision.current) return;
      const regionIdx = loaded.artifact.architecture.condition_regions.indexOf(region);
      setModel(loaded);
      setSource(text);
      setEnabled(true);
      setCondition(regionIdx >= 0 ? regionIdx : 0);
      setStatus(`Loaded best generative model: ${appearanceModelLabel(chosen)}.`);
      try { await storeAppearance(text); }
      catch { /* Browser storage is optional. */ }
    } catch (reason) {
      if (mounted.current && version === revision.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setStatus("");
      }
    } finally {
      if (mounted.current && version === revision.current) setLoadingColab(false);
    }
  };
  const importFile = async (file: File | undefined) => {
    if (!file) return;
    const version = ++revision.current;
    setError(""); setStatus("Verifying model weights and inference parity…");
    try {
      if (!file.size || file.size > MAX_MODEL_FILE_BYTES) throw new Error("Choose a nonempty .tissue-model.json file below 32 MiB.");
      const text = await file.text(), loaded = await parseAppearanceModel(text);
      if (!mounted.current || version !== revision.current) return;
      setModel(loaded); setSource(text); setEnabled(true); setCondition(0);
      try { await storeAppearance(text); }
      catch { if (mounted.current && version === revision.current) setStatus("Model imported for this session; browser storage is unavailable."); }
    } catch (reason) { if (mounted.current && version === revision.current) { setError(reason instanceof Error ? reason.message : String(reason)); setStatus(""); } }
  };
  const remove = () => {
    const version = ++revision.current;
    operation.current?.abort(); setModel(undefined); setSource(""); setAppearance(undefined); setBake(undefined);
    setBusy(false); setStatus("Removing the saved model…"); setError("");
    void removeStoredAppearance().then(() => { if (mounted.current && revision.current === version) setStatus("Model removed from this browser."); })
      .catch(() => { if (mounted.current && revision.current === version) { setStatus(""); setError("Model removed from this view, but browser storage could not be cleared."); } });
  };
  const download = () => {
    if (!bake) return;
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = bake.resolution;
    const context = canvas.getContext("2d"); if (!context) return;
    context.putImageData(new ImageData(new Uint8ClampedArray(bake.rgba), bake.resolution, bake.resolution), 0, 0);
    const link = document.createElement("a"); link.download = `${region}-learned-rgb-${bake.resolution}-seed${seed}.png`; link.href = canvas.toDataURL("image/png"); link.click();
  };
  const sampleVariation = () => {
    try { setSeed(newMaterialSeed()); setEnabled(true); setRetry(value => value + 1); }
    catch { setError("A new seed could not be created. Enter an appearance seed manually to continue."); }
  };
  return <section className="tissue-model-panel" aria-label="Learned tissue appearance">
    <span className="tissue-eyebrow">04 / LEARNED APPEARANCE</span>
    <button type="button" className="tissue-wide tissue-variation-primary" disabled={loadingColab || busy} onClick={() => void loadColabModel()}>{loadingColab ? "Loading best generative model…" : "Use generative models"}</button>
    {colabModels.length > 0 && <label className="tissue-field">Available generative models<select aria-label="Available generative models" value={selectedColabId} disabled={loadingColab || busy} onChange={event => { const nextId = event.target.value; setSelectedColabId(nextId); void loadColabModel(nextId); }}>{colabModels.map(entry => <option key={entry.id} value={entry.id}>{appearanceModelLabel(entry)}</option>)}</select></label>}
    <label className="tissue-field">Import generative model<input type="file" aria-label="Import generative tissue model" accept=".json,application/json" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = ""; }} /></label>
    <p className="tissue-copy">Import the notebook’s .tissue-model.json export. Inference stays in this browser and generates a texture fixed to the tissue surface.</p>
    {model && <>
      <p className="tissue-copy">{model.artifact.provenance.training_status === "fixture_trained" ? "Contract-test weights · not real tissue training" : "Experimental model · real-data research training"}<br />{Number(model.artifact.provenance.training_steps).toLocaleString()} optimizer steps · {String(model.artifact.provenance.training_native_patch_size)}² training patches</p>
      {model.kind === "spatial" && <p className="tissue-copy">Native detail: {model.artifact.architecture.native_resolution.join(" × ")}. Larger texture sizes interpolate this output.</p>}
      {!matching.length ? <p className="tissue-copy" role="status">This model does not cover {region.replaceAll("_", " ")}. The authored material stays active.</p> : <>
        <label className="tissue-field">Learned tissue condition<select aria-label="Learned tissue condition" value={selectedCondition} onChange={event => setCondition(Number(event.target.value))}>{matching.map(index => <option key={index} value={index}>{modelMessage(labels[index]!)}</option>)}</select></label>
        <label className="tissue-field">Appearance seed<input aria-label="Appearance seed" inputMode="numeric" value={seed} onChange={event => setSeed(event.target.value)} /></label>
        <label className="tissue-field">Learned RGB resolution<select aria-label="Learned RGB resolution" value={resolution} onChange={event => setResolution(Number(event.target.value))}><option value="128">128 × 128</option><option value="256">256 × 256</option><option value="512">512 × 512</option></select></label>
        <label className="tissue-check"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Use learned appearance</label>
        <button className="tissue-wide tissue-variation-primary" disabled={busy} onClick={sampleVariation}>New learned variation</button>
        {busy ? <button className="tissue-wide" onClick={() => { operation.current?.abort(); setBusy(false); setStatus("Appearance generation cancelled."); }}>Cancel generation</button> : <button className="tissue-wide" onClick={() => setRetry(value => value + 1)}>Generate again</button>}
        <p className="tissue-variation-help">New variation uses a fresh seed. Generate again repeats the current seed.</p>
        <button className="tissue-wide" disabled={!bake || busy} onClick={download}>Download learned RGB texture</button>
      </>}
      <button className="tissue-wide" onClick={remove}>Remove imported model</button>
    </>}
    {status && <p className="tissue-copy" role="status">{modelMessage(status)}</p>}
    {error && <p className="tissue-model-error" role="alert">{modelMessage(error)}</p>}
  </section>;
}
