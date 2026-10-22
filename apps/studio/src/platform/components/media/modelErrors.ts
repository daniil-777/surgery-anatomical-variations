// One sentence for why a 3D preview could not be shown, from whatever the loader, the network or WebGL threw. Pure (no
// three.js), so ModelViewer can word failures without loading the engine and the rules are unit-tested in node.
import { errorCode } from "../../app/messages";
import { isPlatformError } from "../../core/types";

/** Thrown by the stage for conditions it detects itself; the message is already user-facing. */
export class ModelViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelViewError";
  }
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "";
}

export function describeModelError(error: unknown): string {
  if (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "ModelViewError") return messageOf(error);
  if (isPlatformError(error)) {
    switch (errorCode(error)) {
      case "network":
        return "The model couldn’t be downloaded. Check your connection and try again.";
      case "not_found":
        return "This model is no longer available.";
      case "not_authenticated":
        return "Your session has ended. Sign in again to see this model.";
      default:
        return "The model couldn’t be opened.";
    }
  }
  const text = messageOf(error);
  if (/draco/i.test(text)) return "This model uses Draco mesh compression, which the preview can’t open yet.";
  if (/ktx2|basis/i.test(text)) return "This model uses KTX2 textures, which the preview can’t open yet.";
  if (/unsupported asset|glTF versions/i.test(text)) return "This file isn’t a glTF 2.0 model.";
  if (/Unexpected token|JSON|magic|Invalid typed array|offset is out of bounds/i.test(text)) return "This file isn’t a valid GLB model.";
  if (/webgl|context/i.test(text)) return "3D previews need WebGL, which isn’t available in this browser right now.";
  if (/Failed to fetch|NetworkError|Load failed/i.test(text)) return "The model couldn’t be downloaded. Check your connection and try again.";
  return "The model couldn’t be opened.";
}
