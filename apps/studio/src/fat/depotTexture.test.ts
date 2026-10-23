import { describe, expect, it } from "vitest";
import { bakeDepotRegionTexture } from "./depotTexture";

describe("anatomical regional appearance bake", () => {
  it("reproduces the anatomical field while resolving fine vessel paths separately from gross coverage", () => {
    const domain={seed:42,widthMm:180,heightMm:220};
    const a=bakeDepotRegionTexture(domain,128), b=bakeDepotRegionTexture(domain,128);
    expect(a).toEqual(b);expect(bakeDepotRegionTexture({...domain,seed:231},128)).not.toEqual(a);
    let fat=0, thin=0, vessels=0, offSleeveVessels=0;
    for(let i=0;i<a.length;i+=4){
      expect(a[i+3]).toBe(255);expect(Math.abs(a[i]!+a[i+2]!-255)).toBeLessThanOrEqual(1);
      if(a[i]!>180)fat++;if(a[i]!<50)thin++;
      if(a[i+1]!>128){vessels++;if(a[i]!<40)offSleeveVessels++;}
    }
    expect(fat).toBeGreaterThan(100);expect(thin).toBeGreaterThan(100);
    expect(vessels).toBeGreaterThan(30);expect(vessels).toBeLessThan(128*128*.2);
    expect(offSleeveVessels).toBe(0);
  });
  it("rejects invalid domains and unbounded allocations", () => {
    for(const resolution of [0,1,15,1025,NaN,Infinity,17.5])expect(()=>bakeDepotRegionTexture({seed:42,widthMm:180,heightMm:220},resolution)).toThrow(RangeError);
    for(const domain of [{seed:NaN,widthMm:1,heightMm:1},{seed:42,widthMm:0,heightMm:1},{seed:42,widthMm:1,heightMm:Infinity}])expect(()=>bakeDepotRegionTexture(domain,32)).toThrow(RangeError);
  });
});
