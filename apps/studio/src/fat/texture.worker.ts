import { createFatTextureBaker, bakeFatTexture } from "./texture";

// One worker per recipe; terminating it cancels even a bake in progress. Transfer
// each map immediately so the worker never retains a second 4K copy.
self.onmessage = (event: MessageEvent<{ config: Parameters<typeof bakeFatTexture>[0]; resolution: number }>) => {
  try {
    const {config,resolution}=event.data;
    const baker=createFatTextureBaker(config,resolution);
    for(const map of ["color","height","roughness"] as const) {
      const data=baker.bake(map);
      self.postMessage({map,resolution,data}, { transfer:[data.buffer] });
    }
    self.postMessage({done:true});
  } catch(error) { self.postMessage({error:error instanceof Error?error.message:String(error)}); }
};
