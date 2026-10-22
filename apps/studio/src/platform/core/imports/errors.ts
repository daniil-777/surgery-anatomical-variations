// Refusals raised while analysing an import. ImportRejectedError is a PlatformError, so generic handlers keep working,
// and it carries what the shell shows: `reason` (what is wrong, one sentence) and `advice` (what to do instead, or
// null). `message` joins both; `detail` is a stable key for code and tests ("unsupported:blend", "limit:vertices" …).

import { PlatformError, type PlatformErrorCode } from "../types";
import { IMPORT_LIMITS } from "./limits";

/** Advice shared by several refusals. */
export const ADVICE = Object.freeze({
  decimate: "Reduce it (for example with Blender's Decimate modifier) and export again.",
  resizeTextures: `Scale the textures down to ${IMPORT_LIMITS.imageSide} pixels or less and export again.`,
  emptyScene: "Check that the export includes the meshes (not only empties, cameras or lights).",
});

export interface RefusalOptions {
  /** What the person can do instead (export path, size to aim for …). */
  advice?: string | null | undefined;
  /** invalid_input unless a plan limit (limit_reached, file_too_large) is the cause. */
  code?: PlatformErrorCode | undefined;
  cause?: unknown;
}

export class ImportRejectedError extends PlatformError {
  readonly reason: string;
  readonly advice: string | null;

  constructor(reason: string, detail: string, options: RefusalOptions = {}) {
    const advice = options.advice?.trim() || null;
    super(options.code ?? "invalid_input", advice ? `${reason} ${advice}` : reason, { detail, cause: options.cause });
    this.name = "ImportRejectedError";
    this.reason = reason;
    this.advice = advice;
  }
}

export function importRefusal(reason: string, detail: string, options: RefusalOptions = {}): ImportRejectedError {
  return new ImportRejectedError(reason, detail, options);
}

/** More than one model could be the main file; retry analyzeFiles with options.mainFile set to one of `candidates`. */
export class ImportChoiceError extends ImportRejectedError {
  readonly candidates: string[];

  constructor(reason: string, candidates: string[]) {
    super(reason, "ambiguous-main-file", { advice: "Choose the one to import, or import them one at a time." });
    this.name = "ImportChoiceError";
    this.candidates = candidates;
  }
}

export function abortedError(): PlatformError {
  return new PlatformError("aborted", "The import was cancelled.", { detail: "aborted" });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortedError();
}

/** Settles with `promise`, or rejects as soon as `signal` aborts (loaders cannot be interrupted, but the caller can stop waiting). */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}
