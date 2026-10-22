import { describe, expect, it } from "vitest";
import { encodeTusMetadata, TUS_CHUNK_SIZE, tusUpload } from "./tus";
import { PlatformError } from "./types";

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodySize: number;
}

/** A small in-memory TUS 1.0 server with scriptable failures. */
class FakeTusServer {
  readonly requests: Recorded[] = [];
  readonly uploads = new Map<string, { length: number; data: Uint8Array; offset: number; metadata: string }>();
  /** Responses to send instead of handling, consumed in order (a thrown error simulates a network failure). */
  readonly script: Array<{ method: string; respond: () => Response | never }> = [];
  private next = 1;
  location: (id: number) => string = (id) => `https://storage.test/storage/v1/upload/resumable/${id}`;

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[key.toLowerCase()] = value;
    const body = init?.body as Blob | undefined;
    this.requests.push({ method, url, headers, bodySize: body ? body.size : 0 });
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const scripted = this.script.findIndex((entry) => entry.method === method);
    if (scripted >= 0) {
      const [entry] = this.script.splice(scripted, 1);
      return (entry as { respond: () => Response }).respond();
    }
    if (headers["tus-resumable"] !== "1.0.0") return new Response("missing Tus-Resumable", { status: 412 });
    if (method === "POST") {
      const id = this.next++;
      const length = Number(headers["upload-length"]);
      this.uploads.set(new URL(this.location(id), url).href, { length, data: new Uint8Array(length), offset: 0, metadata: headers["upload-metadata"] ?? "" });
      return new Response(null, { status: 201, headers: { location: this.location(id), "tus-resumable": "1.0.0" } });
    }
    const upload = this.uploads.get(url);
    if (!upload) return new Response("not found", { status: 404 });
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers: { "upload-offset": String(upload.offset), "upload-length": String(upload.length) } });
    }
    if (method === "PATCH") {
      if (Number(headers["upload-offset"]) !== upload.offset) return new Response("offset mismatch", { status: 409 });
      const bytes = new Uint8Array(await (body as Blob).arrayBuffer());
      upload.data.set(bytes, upload.offset);
      upload.offset += bytes.length;
      return new Response(null, { status: 204, headers: { "upload-offset": String(upload.offset) } });
    }
    return new Response("method", { status: 405 });
  };
}

function patterned(size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(size).map((_, index) => (index * 31 + 7) % 256);
}

function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return a !== undefined && a.length === b.length && a.every((value, index) => value === b[index]);
}

const noSleep = async (): Promise<void> => {};

describe("tusUpload", () => {
  it("creates the upload with Supabase metadata and sends 6 MB chunks", async () => {
    const server = new FakeTusServer();
    const bytes = patterned(TUS_CHUNK_SIZE * 2 + 1234);
    const progress: number[] = [];
    const result = await tusUpload({
      endpoint: "https://ref.supabase.co/storage/v1/upload/resumable",
      file: new Blob([bytes]),
      headers: { authorization: "Bearer token", apikey: "sb_publishable_x", "x-upsert": "true" },
      metadata: { bucketName: "user-content", objectName: "u/ab/abc", contentType: "video/mp4", cacheControl: "31536000" },
      fetch: server.fetch,
      onProgress: (p) => progress.push(p.loaded),
    });
    const post = server.requests[0] as Recorded;
    expect(post.method).toBe("POST");
    expect(post.url).toBe("https://ref.supabase.co/storage/v1/upload/resumable");
    expect(post.headers["upload-length"]).toBe(String(bytes.length));
    expect(post.headers.authorization).toBe("Bearer token");
    expect(post.headers.apikey).toBe("sb_publishable_x");
    expect(post.headers["x-upsert"]).toBe("true");
    expect(post.headers["upload-metadata"]).toBe(
      encodeTusMetadata({ bucketName: "user-content", objectName: "u/ab/abc", contentType: "video/mp4", cacheControl: "31536000" }),
    );
    const patches = server.requests.filter((request) => request.method === "PATCH");
    expect(patches.map((request) => request.bodySize)).toEqual([TUS_CHUNK_SIZE, TUS_CHUNK_SIZE, 1234]);
    expect(patches.every((request) => request.headers["content-type"] === "application/offset+octet-stream")).toBe(true);
    expect(patches.map((request) => request.headers["upload-offset"])).toEqual(["0", String(TUS_CHUNK_SIZE), String(TUS_CHUNK_SIZE * 2)]);
    expect(progress).toEqual([0, TUS_CHUNK_SIZE, TUS_CHUNK_SIZE * 2, bytes.length]);
    const stored = server.uploads.get(result.uploadUrl);
    expect(stored?.offset).toBe(bytes.length);
    expect(sameBytes(stored?.data, bytes)).toBe(true);
  });

  it("encodes metadata values as base64 UTF-8", () => {
    expect(encodeTusMetadata({ objectName: "a/b", note: "Gefäß" })).toBe(`objectName ${btoa("a/b")},note ${btoa("GefÃ¤Ã\u009f")}`);
    expect(() => encodeTusMetadata({ "bad key": "x" })).toThrow(PlatformError);
  });

  it("asks the server for its offset after a failed chunk and resumes there", async () => {
    const server = new FakeTusServer();
    const bytes = patterned(1000);
    // the second PATCH reaches the server but the answer is lost
    let patchCount = 0;
    const flaky: typeof fetch = async (input, init) => {
      if (init?.method === "PATCH" && ++patchCount === 2) {
        await server.fetch(input, init);
        throw new TypeError("network connection was lost");
      }
      return server.fetch(input, init);
    };
    const sleeps: number[] = [];
    const result = await tusUpload({
      endpoint: "https://ref.supabase.co/storage/v1/upload/resumable",
      file: new Blob([bytes]),
      chunkSize: 300,
      fetch: flaky,
      retryDelaysMs: [5, 10],
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps).toEqual([5]);
    const methods = server.requests.map((request) => `${request.method} ${request.headers["upload-offset"] ?? ""}`.trim());
    expect(methods).toEqual(["POST", "PATCH 0", "PATCH 300", "HEAD", "PATCH 600", "PATCH 900"]);
    expect(sameBytes(server.uploads.get(result.uploadUrl)?.data, bytes)).toBe(true);
  });

  it("retries 5xx and offset conflicts, then gives up with a mapped error", async () => {
    const server = new FakeTusServer();
    server.script.push({ method: "PATCH", respond: () => new Response("busy", { status: 503 }) });
    server.script.push({ method: "PATCH", respond: () => new Response("conflict", { status: 409 }) });
    await tusUpload({ endpoint: "https://e/upload", file: new Blob([patterned(10)]), fetch: server.fetch, sleep: noSleep });
    expect(server.requests.map((request) => request.method)).toEqual(["POST", "PATCH", "HEAD", "PATCH", "HEAD", "PATCH"]);

    const failing = new FakeTusServer();
    for (let index = 0; index < 10; index += 1) failing.script.push({ method: "PATCH", respond: () => new Response("down", { status: 502 }) });
    const error = await tusUpload({ endpoint: "https://e/upload", file: new Blob([patterned(10)]), fetch: failing.fetch, sleep: noSleep, retryDelaysMs: [1, 1] }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe("network");
    expect(failing.requests.filter((request) => request.method === "PATCH")).toHaveLength(3);
  });

  it("does not retry a refused create (4xx) and maps the Storage body", async () => {
    const server = new FakeTusServer();
    server.script.push({
      method: "POST",
      respond: () => new Response('{"statusCode":"413","error":"Payload too large","message":"The object exceeded the maximum allowed size"}', { status: 413 }),
    });
    const error = (await tusUpload({ endpoint: "https://e/upload", file: new Blob([patterned(10)]), fetch: server.fetch, sleep: noSleep }).catch(
      (caught: unknown) => caught,
    )) as PlatformError;
    expect(error.code).toBe("file_too_large");
    expect(server.requests).toHaveLength(1);

    const rls = new FakeTusServer();
    rls.script.push({ method: "POST", respond: () => new Response("new row violates row-level security policy", { status: 403 }) });
    const denied = (await tusUpload({ endpoint: "https://e/upload", file: new Blob([patterned(10)]), fetch: rls.fetch, sleep: noSleep }).catch(
      (caught: unknown) => caught,
    )) as PlatformError;
    expect(denied.status).toBe(403);
  });

  it("starts again when the upload URL expired", async () => {
    const server = new FakeTusServer();
    const bytes = patterned(500);
    const first = await tusUpload({ endpoint: "https://e/upload", file: new Blob([bytes]), chunkSize: 200, fetch: server.fetch });
    server.uploads.delete(first.uploadUrl);
    const resumed = await tusUpload({ endpoint: "https://e/upload", file: new Blob([bytes]), chunkSize: 200, fetch: server.fetch, uploadUrl: first.uploadUrl });
    expect(resumed.uploadUrl).not.toBe(first.uploadUrl);
    expect(server.uploads.get(resumed.uploadUrl)?.offset).toBe(500);
  });

  it("resumes a known upload URL from the server's offset", async () => {
    const server = new FakeTusServer();
    const bytes = patterned(900);
    // an earlier session stored the first 300 bytes under this URL
    const url = "https://storage.test/storage/v1/upload/resumable/77";
    const data = new Uint8Array(900);
    data.set(bytes.slice(0, 300));
    server.uploads.set(url, { length: 900, data, offset: 300, metadata: "" });
    await tusUpload({ endpoint: "https://e/upload", file: new Blob([bytes]), chunkSize: 300, fetch: server.fetch, uploadUrl: url });
    expect(server.requests.map((request) => `${request.method} ${request.headers["upload-offset"] ?? ""}`.trim())).toEqual(["HEAD", "PATCH 300", "PATCH 600"]);
    expect(sameBytes(server.uploads.get(url)?.data, bytes)).toBe(true);
  });

  it("resolves relative Location headers against the endpoint", async () => {
    const server = new FakeTusServer();
    server.location = (id) => `/storage/v1/upload/resumable/${id}`;
    const result = await tusUpload({ endpoint: "https://ref.supabase.co/storage/v1/upload/resumable", file: new Blob([patterned(5)]), fetch: server.fetch });
    expect(result.uploadUrl).toBe("https://ref.supabase.co/storage/v1/upload/resumable/1");
    expect(server.requests[1]).toMatchObject({ method: "PATCH", url: "https://ref.supabase.co/storage/v1/upload/resumable/1" });
  });

  it("stops at once when aborted and sends nothing more", async () => {
    const server = new FakeTusServer();
    const controller = new AbortController();
    const counting: typeof fetch = async (input, init) => {
      const response = await server.fetch(input, init);
      if (init?.method === "PATCH") controller.abort();
      return response;
    };
    const error = (await tusUpload({
      endpoint: "https://e/upload",
      file: new Blob([patterned(1000)]),
      chunkSize: 100,
      fetch: counting,
      signal: controller.signal,
    }).catch((caught: unknown) => caught)) as PlatformError;
    expect(error.code).toBe("aborted");
    expect(server.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
  });

  it("calls a header function per request (fresh access tokens)", async () => {
    const server = new FakeTusServer();
    let calls = 0;
    await tusUpload({
      endpoint: "https://e/upload",
      file: new Blob([patterned(250)]),
      chunkSize: 100,
      fetch: server.fetch,
      headers: async () => ({ authorization: `Bearer t${++calls}` }),
    });
    expect(server.requests.map((request) => request.headers.authorization)).toEqual(["Bearer t1", "Bearer t2", "Bearer t3", "Bearer t4"]);
  });
});
