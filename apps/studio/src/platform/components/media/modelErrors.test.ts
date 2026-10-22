import { describe, expect, it } from "vitest";
import { PlatformError } from "../../core/types";
import { describeModelError, ModelViewError } from "./modelErrors";

describe("model preview errors", () => {
  it("keeps the stage's own sentences", () => {
    expect(describeModelError(new ModelViewError("This model has nothing to show."))).toBe("This model has nothing to show.");
  });

  it("words loader, network and WebGL failures", () => {
    expect(describeModelError(new Error("THREE.GLTFLoader: No DRACOLoader instance provided."))).toMatch(/Draco/);
    expect(describeModelError(new Error("THREE.GLTFLoader: setKTX2Loader must be called before loading KTX2 textures."))).toMatch(/KTX2/);
    expect(describeModelError(new Error("THREE.GLTFLoader: Unsupported asset. glTF versions >=2.0 are supported."))).toBe("This file isn’t a glTF 2.0 model.");
    expect(describeModelError(new SyntaxError("Unexpected token 'g', \"glTF\" is not valid JSON"))).toBe("This file isn’t a valid GLB model.");
    expect(describeModelError(new TypeError("Failed to fetch"))).toMatch(/couldn’t be downloaded/);
    expect(describeModelError(new PlatformError("network"))).toMatch(/couldn’t be downloaded/);
    expect(describeModelError(new PlatformError("not_found"))).toBe("This model is no longer available.");
    expect(describeModelError(new Error("Error creating WebGL context."))).toMatch(/WebGL/);
    expect(describeModelError("weird")).toBe("The model couldn’t be opened.");
    expect(describeModelError(null)).toBe("The model couldn’t be opened.");
  });
});
