// Sync server: stores each sync code's progress.
//
//   GET  /api/progress   header x-sync-code, optional if-none-match: <etag>
//                        -> 200 {"etag", "state"}, 304 (unchanged), or 404 {"error":"none"}
//   PUT  /api/progress   header x-sync-code, optional if-match: <etag>, body: the state
//                        -> 200 {"etag"} or 409 {"error":"conflict"}
//
// The record is named by a hash of the code, so only someone with the code can read or write
// it. Writes are conditional on the version the device last saw, so two devices can't
// silently overwrite each other; the device that loses merges and tries again.
//
// Storage: Upstash Redis when it's connected to the project (its free tier allows hundreds of
// thousands of operations a month), otherwise Vercel Blob (whose free tier allows only 2,000
// writes a month). With Redis connected, a code's progress still in Blob is copied over the
// first time it's read, so switching loses nothing.

import { createHash, randomUUID } from "node:crypto";
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

/** What a store holds for a code: the saved state (JSON text) and its version. */
type Stored = { etag: string; text: string };

interface Store {
  /** null when there's nothing saved; "unchanged" when it's still the version the caller has */
  read(path: string, ifNoneMatch?: string): Promise<Stored | "unchanged" | null>;
  /** the new version, or "conflict" when ifMatch is given and isn't the current version */
  write(path: string, text: string, ifMatch?: string): Promise<string | "conflict">;
}

/**
 * Compressed reads (Blob's) turn a version tag weak, which turns the version tag weak (W/"abc"), while writes
 * only match the strong form ("abc"). Same version, so compare and hand out the strong form.
 */
function strong(etag: string): string {
  return etag.replace(/^W\//, "");
}

// ---------------------------------------------------------------- Upstash Redis (REST)

/** Vercel's Upstash integration sets KV_REST_API_*; a direct Upstash setup sets UPSTASH_REDIS_REST_*. */
function redisConfig(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

// Write only if the stored version is the expected one ('' means write regardless).
const CAS = `local cur = redis.call('HGET', KEYS[1], 'v')
if ARGV[1] ~= '' and cur ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'v', ARGV[2], 'd', ARGV[3])
return 1`;

function redisStore(cfg: { url: string; token: string }): Store {
  const call = async (command: (string | number)[]): Promise<unknown> => {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify(command),
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string } | null;
    if (!res.ok || !body || body.error) throw new Error(`redis: ${body?.error ?? res.status}`);
    return body.result;
  };
  const key = (path: string) => `sat:${path}`;
  return {
    async read(path, ifNoneMatch) {
      const [v, d] = ((await call(["HMGET", key(path), "v", "d"])) as (string | null)[]) ?? [];
      if (!v || d == null) return null;
      if (ifNoneMatch && strong(ifNoneMatch) === v) return "unchanged";
      return { etag: v, text: d };
    },
    async write(path, text, ifMatch) {
      const etag = `"${randomUUID()}"`;
      const ok = await call(["EVAL", CAS, 1, key(path), ifMatch ? strong(ifMatch) : "", etag, text]);
      return ok === 1 ? etag : "conflict";
    },
  };
}

// ---------------------------------------------------------------- Vercel Blob

function blobConfigured(): boolean {
  return !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

const blobStore: Store = {
  async read(path, ifNoneMatch) {
    let blob;
    try {
      blob = await get(path, { access: "private", useCache: false, ...(ifNoneMatch ? { ifNoneMatch: strong(ifNoneMatch) } : {}) });
    } catch (e) {
      if (e instanceof BlobNotFoundError) return null;
      throw e;
    }
    if (!blob) return null;
    if (blob.statusCode === 304) return "unchanged";
    if (blob.statusCode !== 200 || !blob.stream) return null;
    return { etag: strong(blob.blob.etag), text: await new Response(blob.stream).text() };
  },
  async write(path, text, ifMatch) {
    try {
      const saved = await put(path, text, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
        ...(ifMatch ? { ifMatch: strong(ifMatch) } : {}),
      });
      return strong(saved.etag);
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError) return "conflict";
      throw e;
    }
  },
};

// ---------------------------------------------------------------- requests

async function read(store: Store, path: string, request: Request, fromBlob: boolean): Promise<Response> {
  const ifNoneMatch = request.headers.get("if-none-match") ?? undefined;
  let found = await store.read(path, ifNoneMatch);
  if (found === null && fromBlob) {
    // first read after switching to Redis: bring this code's progress over from Blob
    try {
      const old = await blobStore.read(path);
      if (old && old !== "unchanged") {
        const etag = await store.write(path, old.text);
        if (etag !== "conflict") found = { etag, text: old.text };
      }
    } catch {
      // Blob unreachable: carry on as if there were nothing saved
    }
  }
  if (found === "unchanged") return new Response(null, { status: 304, headers: { "cache-control": "no-store" } });
  if (!found) return reply({ error: "none" }, 404);
  // the stored text is already JSON: wrap it without parsing
  return new Response(`{"etag":${JSON.stringify(found.etag)},"state":${found.text}}`, {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function write(store: Store, path: string, request: Request): Promise<Response> {
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
  const etag = await store.write(path, text, request.headers.get("if-match") ?? undefined);
  return etag === "conflict" ? reply({ error: "conflict" }, 409) : reply({ etag });
}

export async function handle(request: Request): Promise<Response> {
  const redis = redisConfig();
  const res = await respond(request, redis);
  // tells the app which store is in use, so it can sync more often when that's cheap
  res.headers.set("x-sync-store", redis ? "redis" : "blob");
  return res;
}

async function respond(request: Request, redis: { url: string; token: string } | null): Promise<Response> {
  const path = pathFor(request.headers.get("x-sync-code") ?? "");
  if (!path) return reply({ error: "bad-code" }, 400);
  const store = redis ? redisStore(redis) : blobStore;
  try {
    if (request.method === "GET") return await read(store, path, request, !!redis && blobConfigured());
    if (request.method === "PUT") return await write(store, path, request);
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
