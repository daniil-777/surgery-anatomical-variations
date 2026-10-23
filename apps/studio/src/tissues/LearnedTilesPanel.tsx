import { useEffect, useMemo, useRef, useState } from "react";
import { publicUrl } from "../api";
import type { TissueEntry } from "./contracts";
import { BROWSER_GENERATOR_HEALTH, generateBrowserTileBundle } from "./browserTileGenerator";
import { checkGenerator, generatorBaseUrl, MODE_LABELS, requestGeneratedTile, type GeneratorHealth, type GeneratorMode } from "./generatorClient";
import { catalogGroups, learnedForFamily, shortLearnedLabel } from "./learnedCatalog";
import { exportBakedOrganGlb, exportBakedOrganUnityZip, resolveBakeOrgan, rgbaImageToDataUrl, type OrganMeshBakeResult } from "./organMeshBake";

const SERVER_COMMAND = "scripts/tissue_lora_server.py --model <sd15 snapshot> --lora <checkpoint> --work <jobs dir> --colour-stats <stats.json> --warm";

export type BakedAtlasChannel = "albedo" | "normal" | "roughness";

interface LearnedTilesPanelProps {
  catalog: readonly TissueEntry[];
  family: string | undefined;
  selectedId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
  /** Must validate and apply the bundle exactly like a manual import; rejects on invalid data. */
  onGenerated: (source: string, filename: string) => Promise<boolean>;
  organBakeActive?: boolean | undefined;
  organBakeResult?: OrganMeshBakeResult | undefined;
  organBakeTileScaleMm?: number | undefined;
  organBakeSharpness?: number | undefined;
  onBakeOntoOrgan?: () => void;
  onUpdateBakeOptions?: (changes: { tileScaleMm?: number; blendSharpness?: number }) => void;
}

const familyLabel = (family: string) => family.replaceAll("_", " ");

export function LearnedTilesPanel({
  catalog,
  family,
  selectedId,
  disabled,
  onSelect,
  onGenerated,
  organBakeActive,
  organBakeResult,
  organBakeTileScaleMm = 51.2,
  organBakeSharpness = 6,
  onBakeOntoOrgan,
  onUpdateBakeOptions,
}: LearnedTilesPanelProps) {
  const tiles = useMemo(() => learnedForFamily(catalog, family), [catalog, family]);
  const groups = useMemo(() => catalogGroups(tiles), [tiles]);
  const bakeOrgan = useMemo(() => resolveBakeOrgan(family), [family]);
  const [health, setHealth] = useState<GeneratorHealth>();
  const [browserFallback, setBrowserFallback] = useState(false);
  const [connecting, setConnecting] = useState(false), [generating, setGenerating] = useState(false);
  const [targetFamily, setTargetFamily] = useState(""), [mode, setMode] = useState<GeneratorMode>("clean");
  const [status, setStatus] = useState(""), [error, setError] = useState(""), [elapsed, setElapsed] = useState(0);
  const [atlasChannel, setAtlasChannel] = useState<BakedAtlasChannel>("albedo");
  const [exportingGlb, setExportingGlb] = useState(false);
  const [exportingUnity, setExportingUnity] = useState(false);
  const [bakeStatus, setBakeStatus] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!generating) return;
    const started = performance.now();
    const timer = window.setInterval(() => setElapsed(Math.round((performance.now() - started) / 1000)), 500);
    return () => window.clearInterval(timer);
  }, [generating]);
  useEffect(() => {
    // Follow the displayed family when the generator supports it.
    if (health && family && health.families.includes(family)) setTargetFamily(family);
  }, [family, health]);

  const atlasPreviewUrl = useMemo(() => {
    if (!organBakeResult || typeof document === "undefined") return "";
    const img = atlasChannel === "normal"
      ? organBakeResult.normalAtlas
      : atlasChannel === "roughness"
        ? organBakeResult.roughnessAtlas
        : organBakeResult.albedoAtlas;
    return rgbaImageToDataUrl(img);
  }, [organBakeResult, atlasChannel]);

  const saveAtlasPng = () => {
    if (!organBakeResult || !atlasPreviewUrl) return;
    const link = document.createElement("a");
    link.href = atlasPreviewUrl;
    link.download = `${organBakeResult.organ}-baked-${atlasChannel}-atlas.png`;
    link.click();
  };

  const downloadBakedGlb = async () => {
    if (!organBakeResult || exportingGlb) return;
    setExportingGlb(true);
    setBakeStatus("");
    try {
      const glb = await exportBakedOrganGlb(organBakeResult);
      const url = URL.createObjectURL(new Blob([glb], { type: "model/gltf-binary" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${organBakeResult.organ}-baked-learned-tile.glb`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      setBakeStatus(`Exported ${organBakeResult.organ}-baked-learned-tile.glb (metres, embedded PBR maps).`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExportingGlb(false);
    }
  };

  const downloadUnityPackage = async () => {
    if (!organBakeResult || exportingUnity) return;
    setExportingUnity(true);
    setBakeStatus("");
    try {
      const zipBytes = await exportBakedOrganUnityZip(organBakeResult);
      const url = URL.createObjectURL(new Blob([zipBytes as unknown as BlobPart], { type: "application/zip" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `${organBakeResult.organ}-unity-pbr-package.zip`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      setBakeStatus(`Exported Unity PBR package: ${organBakeResult.organ}-unity-pbr-package.zip (GLB + BaseMap + NormalMap + MetallicSmoothness + C# setup).`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExportingUnity(false);
    }
  };

  const connect = async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setConnecting(true); setError(""); setStatus("Contacting the local generator…");
    let base: string;
    try {
      base = generatorBaseUrl();
    } catch (reason) {
      setHealth(undefined);
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus("");
      setConnecting(false);
      request.current = undefined;
      return;
    }
    try {
      const reply = await checkGenerator(base, controller.signal);
      setBrowserFallback(false);
      setHealth(reply);
      setTargetFamily(family && reply.families.includes(family) ? family : reply.families[0]!);
      setMode(reply.modes.includes("clean") ? "clean" : reply.modes[0]!);
      setStatus(reply.busy ? "Connected. The generator is finishing another tile." : "Connected.");
    } catch {
      if (!controller.signal.aborted) {
        const reply = BROWSER_GENERATOR_HEALTH;
        setBrowserFallback(true);
        setHealth(reply);
        setTargetFamily(family && reply.families.includes(family) ? family : reply.families[0]!);
        setMode(reply.modes.includes("clean") ? "clean" : reply.modes[0]!);
        setError("");
        setStatus("Connected automatically (built-in browser tile generator active).");
      }
    } finally {
      if (request.current === controller) { setConnecting(false); request.current = undefined; }
    }
  };
  const generate = async () => {
    if (!health || !targetFamily) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setGenerating(true); setElapsed(0); setError(""); setStatus(`Generating a ${familyLabel(targetFamily)} tile…`);
    try {
      let source: string;
      if (browserFallback) {
        source = await generateBrowserTileBundle({ family: targetFamily, mode }, controller.signal);
      } else {
        try {
          source = await requestGeneratedTile(generatorBaseUrl(), { family: targetFamily, mode }, controller.signal);
        } catch (reason) {
          const message = reason instanceof Error ? reason.message : String(reason);
          if (!controller.signal.aborted && message.includes("stopped answering")) {
            setBrowserFallback(true);
            setHealth(BROWSER_GENERATOR_HEALTH);
            source = await generateBrowserTileBundle({ family: targetFamily, mode }, controller.signal);
          } else {
            throw reason;
          }
        }
      }
      if (controller.signal.aborted) return;
      setStatus("Checking the generated maps…");
      const seed = /"seed":"(\d+)"/.exec(source.slice(0, 4096))?.[1] ?? "new";
      const applied = await onGenerated(source, `${targetFamily}-learned-seed${seed}.tissue-pbr.json`);
      if (!controller.signal.aborted) setStatus(applied ? `Generated ${familyLabel(targetFamily)} · seed ${seed}. It is shown as an imported candidate; export it to keep it.` : "");
    } catch (reason) {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : String(reason)); setStatus(""); }
    } finally {
      if (request.current === controller) { setGenerating(false); request.current = undefined; }
    }
  };
  const cancel = () => { request.current?.abort(); request.current = undefined; setGenerating(false); setConnecting(false); setStatus("Cancelled. The current material is unchanged."); };

  return <section className="tissue-learned-panel" aria-labelledby="tissue-learned-title">
    <div className="tissue-variation-heading"><h3 id="tissue-learned-title">Learned tiles</h3><span className="tissue-variation-badge">RESEARCH LORA</span></div>
    <p className="tissue-variation-help">Seamless tiles sampled from a LoRA trained on laparoscopic photographs. They are learned appearance, not measured albedo.</p>
    {family && <p className="tissue-learned-count">{tiles.length ? `${tiles.length} learned ${tiles.length === 1 ? "tile" : "tiles"} · ${familyLabel(family)}` : `No learned tiles for ${familyLabel(family)} in this library.`}</p>}
    {tiles.length > 0 && <div className="tissue-learned-gallery" role="group" aria-label={`Learned ${family ? familyLabel(family) : ""} tiles`}>
      {groups.map(group => <div key={group.label}>
        <span className="tissue-learned-group">{group.label.replace(/^Learned · /, "")}</span>
        <div className="tissue-learned-grid">
          {group.entries.map(entry => <button key={entry.id} type="button" className="tissue-learned-tile" disabled={disabled} aria-pressed={entry.id === selectedId}
            aria-label={`Show ${entry.label}`} title={entry.label} onClick={() => onSelect(entry.id)}>
            <img src={publicUrl(`tissue-materials/${entry.thumbnail ?? entry.preview.replace("manifest.json", "base_color.png")}`)} alt="" loading="lazy" width={64} height={64} />
            <span>{shortLearnedLabel(entry)}</span>
          </button>)}
        </div>
      </div>)}
    </div>}
    {bakeOrgan && onBakeOntoOrgan && (
      <div className="tissue-organ-bake">
        <button
          type="button"
          className="tissue-wide tissue-variation-primary"
          disabled={disabled}
          aria-pressed={Boolean(organBakeActive && organBakeResult)}
          onClick={onBakeOntoOrgan}
        >
          {organBakeActive && organBakeResult
            ? `Baked on 3D ${familyLabel(bakeOrgan)} mesh ✓`
            : `Bake onto 3D ${familyLabel(bakeOrgan)} mesh`}
        </button>
        {organBakeResult && (
          <div className="tissue-organ-bake-card" role="region" aria-label="Baked 3D organ mesh">
            <div className="tissue-organ-bake-header">
              <span className="tissue-organ-bake-title">3D {familyLabel(organBakeResult.organ)} bake</span>
              <span className="tissue-organ-bake-badge">{(organBakeResult.metrics.seamContinuity * 100).toFixed(1)}% seam-free</span>
            </div>
            <div className="tissue-organ-bake-preview-row">
              {atlasPreviewUrl && <img className="tissue-organ-bake-thumb" src={atlasPreviewUrl} alt={`Baked ${organBakeResult.organ} ${atlasChannel} UV atlas`} width={96} height={96} />}
              <div className="tissue-organ-bake-meta">
                <strong>{organBakeResult.metrics.chartCount}-chart UV atlas · {organBakeResult.metrics.atlasResolution}²</strong>
                <div>{organBakeResult.metrics.triangleCount.toLocaleString()} tris · {Math.round(organBakeResult.metrics.coverageFraction * 100)}% chart fill</div>
                <div>Aperiodic 2-octave · L2 variance-preserving</div>
                <div className="tissue-organ-bake-tabs" role="group" aria-label="Baked UV atlas channel">
                  {(["albedo", "normal", "roughness"] as const).map(ch => (
                    <button key={ch} type="button" className="tissue-organ-bake-tab" aria-pressed={atlasChannel === ch} onClick={() => setAtlasChannel(ch)}>
                      {ch}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {onUpdateBakeOptions && (
              <>
                <label className="tissue-slider">
                  <span>Organ tile scale<output>{Math.round(organBakeTileScaleMm)} mm</output></span>
                  <input type="range" aria-label="Organ tile scale" min="25" max="140" step="1" value={Math.round(organBakeTileScaleMm)} onChange={e => onUpdateBakeOptions({ tileScaleMm: Number(e.target.value) })} />
                </label>
                <label className="tissue-slider">
                  <span>Seam blend sharpness<output>{organBakeSharpness}</output></span>
                  <input type="range" aria-label="Seam blend sharpness" min="2" max="12" step="1" value={organBakeSharpness} onChange={e => onUpdateBakeOptions({ blendSharpness: Number(e.target.value) })} />
                </label>
              </>
            )}
            <button
              type="button"
              className="tissue-wide tissue-unity-export"
              disabled={exportingUnity || exportingGlb}
              onClick={() => void downloadUnityPackage()}
            >
              <span className="tissue-unity-badge" aria-hidden="true">UNITY</span>
              <span>{exportingUnity ? "Packaging Unity PBR…" : "Export to Unity (.zip)"}</span>
            </button>
            <div className="tissue-organ-bake-actions">
              <button type="button" disabled={exportingGlb || exportingUnity} onClick={() => void downloadBakedGlb()}>
                {exportingGlb ? "Exporting GLB…" : "Export 3D organ (.glb)"}
              </button>
              <button type="button" onClick={saveAtlasPng}>
                Save UV atlas (.png)
              </button>
            </div>
            {bakeStatus && <p className="tissue-organ-bake-status" role="status">{bakeStatus}</p>}
          </div>
        )}
      </div>
    )}
    <div className="tissue-generator">
      {!health ? <>
        <button type="button" className="tissue-wide" disabled={connecting || disabled} onClick={() => void connect()}>{connecting ? "Connecting…" : "Connect to local generator"}</button>
        <p className="tissue-variation-help">Generate new tiles on this computer with the trained model. Start the generator first:</p>
        <code className="tissue-command">{SERVER_COMMAND}</code>
      </> : <>
        <dl className="tissue-pbr-provenance tissue-generator-status">
          <div><dt>Generator</dt><dd>{health.run_id ?? "unnamed run"}</dd></div>
          <div><dt>Data rights</dt><dd>{health.rights.training_profile === "unrestricted" ? "Open-licence training data" : "Research use only (training data licence)"}</dd></div>
        </dl>
        <label className="tissue-field">Tissue family<select aria-label="Generator tissue family" value={targetFamily} disabled={generating} onChange={event => setTargetFamily(event.target.value)}>
          {health.families.map(item => <option key={item} value={item}>{familyLabel(item)}</option>)}</select></label>
        <label className="tissue-field">Generation mode<select aria-label="Generation mode" value={mode} disabled={generating} onChange={event => setMode(event.target.value as GeneratorMode)}>
          {health.modes.map(item => <option key={item} value={item}>{MODE_LABELS[item]}</option>)}</select></label>
        <button type="button" className="tissue-wide tissue-variation-primary" disabled={generating || disabled} onClick={() => void generate()}>{generating ? `Generating… ${elapsed} s` : "Generate new tile"}</button>
        {generating && <button type="button" className="tissue-wide" onClick={cancel}>Cancel generation</button>}
        <button type="button" className="tissue-wide" disabled={generating || connecting} onClick={() => void connect()}>Reconnect</button>
      </>}
      {connecting && <button type="button" className="tissue-wide" onClick={cancel}>Cancel</button>}
      {status && <p className="tissue-copy" role="status">{status}</p>}
      {error && <p className="tissue-model-error" role="alert">{error}</p>}
    </div>
  </section>;
}
