// Sync server: stores each sync code's progress as one private file in Vercel Blob.
//
//   GET  /api/progress   header x-sync-code   -> 200 {"etag", "state"} or 404 {"error":"none"}
//   PUT  /api/progress   header x-sync-code, optional if-match: <etag>, body: the state
//                                             -> 200 {"etag"} or 409 {"error":"conflict"}
//
// The file is named by a hash of the code, so only someone with the code can read or write
// it. Writes are conditional on the version the device last saw, so two devices can't
// silently overwrite each other; the device that loses merges and tries again.
//
// Needs a Blob store connected to the Vercel project (it provides BLOB_READ_WRITE_TOKEN).

import { createHash } from "node:crypto";
import { BlobNotFoundError, BlobPreconditionFailedError, BlobStoreSuspendedError, get, put } from "@vercel/blob";

const MAX_BYTES = 4 * 1024 * 1024;

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export function pathFor(code: string): string | null {
  const clean = code.toLowerCase();
  if (!/^[a-z0-9]{20,64}$/.test(clean)) return null;
  return `progress/${createHash("sha256").update(clean).digest("hex")}.json`;
}

async function read(path: string): Promise<Response> {
  let blob;
  try {
    blob = await get(path, { access: "private", useCache: false });
  } catch (e) {
    if (e instanceof BlobNotFoundError) return reply({ error: "none" }, 404);
    throw e;
  }
  if (!blob || blob.statusCode !== 200 || !blob.stream) return reply({ error: "none" }, 404);
  const text = await new Response(blob.stream).text();
  // the stored file is already JSON: wrap it without parsing
  return new Response(`{"etag":${JSON.stringify(blob.blob.etag)},"state":${text}}`, {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function write(path: string, request: Request): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_BYTES) return reply({ error: "too-large" }, 413);
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch {
    return reply({ error: "bad-json" }, 400);
  }
  const s = state as { v?: unknown; q?: unknown; log?: unknown } | null;
  if (!s || s.v !== 1 || typeof s.q !== "object" || !Array.isArray(s.log)) return reply({ error: "bad-state" }, 400);
  const ifMatch = request.headers.get("if-match") ?? undefined;
  try {
    const saved = await put(path, text, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      ...(ifMatch ? { ifMatch } : {}),
    });
    return reply({ etag: saved.etag });
  } catch (e) {
    if (e instanceof BlobPreconditionFailedError) return reply({ error: "conflict" }, 409);
    throw e;
  }
}

export async function handle(request: Request): Promise<Response> {
  const path = pathFor(request.headers.get("x-sync-code") ?? "");
  if (!path) return reply({ error: "bad-code" }, 400);
  try {
    if (request.method === "GET") return await read(path);
    if (request.method === "PUT") return await write(path, request);
    return reply({ error: "method" }, 405);
  } catch (e) {
    if (e instanceof BlobStoreSuspendedError) return reply({ error: "suspended" }, 503);
    const message = e instanceof Error ? e.message : String(e);
    if (/token|credential|store id|BLOB_/i.test(message)) return reply({ error: "not-configured" }, 503);
    console.error("sync error", message);
    return reply({ error: "server" }, 500);
  }
}

const progress = { fetch: handle };
export default progress;
