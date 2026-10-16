import { useEffect, useState } from "react";
import { Camera, ImagePlus, Pipette } from "lucide-react";
import { useApiOnline } from "./api";
import { GENERATION_NOTICE, photoManifest, type PhotoTileInfo } from "./photoDetail";

interface Props { organ: string; value: number; relief: number; tile: PhotoTileInfo | null; disabled: boolean; onTile: (tile: PhotoTileInfo | null) => void; onChange: (value: number) => void; onRelief: (value: number) => void; onApplyColor?: ((reference: NonNullable<PhotoTileInfo["reference_color"]>) => void) | undefined }

/** The photo-detail controls of the texture lab's Surface tab: strength, relief, the photograph's measured colour, its
 * provenance, and the place to bring a photograph of one's own (which, for now, explains why generation cannot run). */
export function PhotoDetailControl({ organ, value, relief, tile, disabled, onTile, onChange, onRelief, onApplyColor }: Props) {
  useEffect(() => { let live = true; void photoManifest().then((m) => { if (live) onTile(m?.organs[organ] ?? null); }); return () => { live = false; }; }, [organ, onTile]);
  const online = useApiOnline();
  const [attempted, setAttempted] = useState<string | null>(null);
  return <section className="atlas-recipe atlas-photo-detail" aria-label="Photo detail">
    <div className="atlas-recipe-heading"><span><Camera size={14} />Photo detail</span></div>
    {tile ? <>
      <label className="atlas-control"><span>Strength<output>{Math.round(value * 100)}%</output></span>
        <input type="range" min={0} max={2} step={0.01} value={value} disabled={disabled} aria-label="Photo detail strength" onChange={(event) => onChange(Number(event.target.value))} /></label>
      <label className="atlas-control"><span>Relief<output>{relief.toFixed(3)} mm</output></span>
        <input type="range" min={0} max={0.12} step={0.001} value={relief} disabled={disabled} aria-label="Photo relief height" onChange={(event) => onRelief(Number(event.target.value))} /></label>
      {tile.reference_color && onApplyColor && <button type="button" className="atlas-btn atlas-reference-analyze" disabled={disabled} onClick={() => onApplyColor(tile.reference_color!)} title={`Observed sRGB ${tile.reference_color.observed_srgb.map((v) => v.toFixed(3)).join(" ")}${tile.color_quality ? ` · ${Math.round(tile.color_quality.accepted_fraction * 100)}% of the region retained` : ""}`}><Pipette size={14} />Use this photograph's colour</button>}
      <p className="atlas-reference-help">Surface detail cut from a surgical photograph ({tile.source.collection}, {tile.source.license ?? "licensed"}; {tile.source.credit ?? tile.source.id}), its lighting flattened and laid over the tissue without repetition. 100 % is the photograph's own contrast; relief turns its shading into fine surface height. It modulates the colour above without shifting it; it is not calibrated albedo, and exports do not carry it.{tile.source.identity ? ` Organ identity: ${tile.source.identity}.` : ""}</p>
    </> : <p className="atlas-reference-help">No licensed photograph of this organ is bundled yet; the surface stays procedural.</p>}
    <div className="atlas-photo-generate">
      <label className="atlas-btn atlas-photo-generate-button"><ImagePlus size={14} />Generate from your photograph<input type="file" accept="image/*" aria-label="Photograph for a new tile" onChange={(event) => { const file = event.target.files?.[0]; setAttempted(file ? file.name : null); event.target.value = ""; }} /></label>
      {attempted && <p className="atlas-reference-help atlas-photo-generate-notice" role="status"><strong>{attempted}</strong> was not used. {online === false ? GENERATION_NOTICE.offline : GENERATION_NOTICE.online}</p>}
    </div>
  </section>;
}
