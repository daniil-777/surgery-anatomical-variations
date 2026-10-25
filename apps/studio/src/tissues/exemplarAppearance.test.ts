import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAppearanceModel, appearanceLatent, bakeAppearanceRows, decodeAppearance } from "./neuralAppearance";
import { selectBestColabAppearanceModel, DEFAULT_COLAB_APPEARANCE_MODELS } from "./colabModels";
import { encodePng } from "./pngEncoder";
const modelSource = (organ: string) => readFileSync(`apps/studio/public/tissue-models/exemplar-${organ}.tissue-model.json`, "utf8");
const output = "artifacts/tissue-material-repair-2026-10-25/samples";
describe("fitted tissue appearance", () => {
  it.each(["liver","spleen","stomach","small_bowel","large_bowel","pancreas"])("preserves %s color and native detail with periodic seams", async organ => {
    const model = await parseAppearanceModel(modelSource(organ)), latent = await appearanceLatent("42",16);
    const rgba = new Uint8Array(512*512*4);bakeAppearanceRows(model,latent,0,512,0,512,rgba);
    const mean=[0,0,0]; let min=255,max=0,gradient=0;
    for(let i=0;i<512*512;i++) {
      for(let c=0;c<3;c++) mean[c]!+=rgba[i*4+c]!/(512*512);
      min=Math.min(min,rgba[i*4]!);max=Math.max(max,rgba[i*4]!);
      if(i%512)gradient+=Math.abs(rgba[i*4]!-rgba[(i-1)*4]!)/(512*511);
    }
    mkdirSync(output,{recursive:true});writeFileSync(`${output}/${organ}-42.png`,encodePng(512,512,4,rgba));
    writeFileSync(`${output}/${organ}-metrics.json`,JSON.stringify({mean,min,max,gradient}));
    expect(mean[0]!).toBeGreaterThan(mean[1]!*1.2);
    expect(max-min).toBeGreaterThan(Number(model.artifact.provenance.source_red_range_srgb)*.45);
    expect(gradient).toBeGreaterThan(Number(model.artifact.provenance.source_gradient_mean_srgb)*.45);
    for(const t of [.017,.32,.81]) {
      expect([...decodeAppearance(model,latent,0,0,t)]).toEqual([...decodeAppearance(model,latent,0,1,t)]);
      expect([...decodeAppearance(model,latent,0,t,0)]).toEqual([...decodeAppearance(model,latent,0,t,1)]);
    }
  });
  it("replays exact seeds, uses all 64 bits and varies adjacent seeds",async()=>{
    mkdirSync(output,{recursive:true}); const model=await parseAppearanceModel(modelSource("liver")), images=[];
    for(const seed of ["0","42","43","4294967338","18446744073709551615","42"]){
      const rgba=new Uint8Array(128*128*4);bakeAppearanceRows(model,await appearanceLatent(seed,16),0,128,0,128,rgba);images.push(rgba);
      writeFileSync(`${output}/liver-${seed}-128.png`,encodePng(128,128,4,rgba));
    }
    expect(images[1]).toEqual(images[5]);
    for(let i=1;i<5;i++)expect(images[i]).not.toEqual(images[i-1]);
    expect(images[1]).not.toEqual(images[3]);
  });
  it("rejects corrupt payloads, distributions and false PBR claims",async()=>{
    for(const mutate of [(m:any)=>m.weights.data_base64="A"+m.weights.data_base64.slice(1),(m:any)=>m.statistics.basis[0][0]=0,(m:any)=>m.statistics.quantiles[0][500]=-5,(m:any)=>m.output.pbr_ground_truth=true]){
      const data=JSON.parse(modelSource("liver"));mutate(data);await expect(parseAppearanceModel(JSON.stringify(data))).rejects.toThrow();
    }
  });
  it("does not recommend test weights or silently switch organs",()=>{
    expect(selectBestColabAppearanceModel(DEFAULT_COLAB_APPEARANCE_MODELS,"liver")?.id).toBe("exemplar-liver");
    expect(selectBestColabAppearanceModel(DEFAULT_COLAB_APPEARANCE_MODELS,"kidney")).toBeUndefined();
    expect(selectBestColabAppearanceModel(DEFAULT_COLAB_APPEARANCE_MODELS,"liver","spatial-v3-laparoscopic")?.id).toBe("spatial-v3-laparoscopic");
  });
});
