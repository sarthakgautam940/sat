import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory stand-in for Vercel Blob with the same conditional read and write behavior.
const blobs = new Map<string, { text: string; etag: string }>();
let version = 0;
const blobCalls = { get: 0, put: 0 };
vi.mock("@vercel/blob", () => {
  class BlobError extends Error {}
  class BlobPreconditionFailedError extends BlobError {}
  class BlobNotFoundError extends BlobError {}
  class BlobStoreSuspendedError extends BlobError {}
  return {
    BlobPreconditionFailedError,
    BlobNotFoundError,
    BlobStoreSuspendedError,
    get: async (path: string, opts: { ifNoneMatch?: string }) => {
      blobCalls.get++;
      const f = blobs.get(path);
      if (!f) return null;
      if (opts.ifNoneMatch && opts.ifNoneMatch === f.etag) return { statusCode: 304, stream: null, blob: { etag: f.etag } };
      return { statusCode: 200, stream: new Blob([f.text]).stream(), blob: { etag: f.etag } };
    },
    put: async (path: string, text: string, opts: { ifMatch?: string }) => {
      blobCalls.put++;
      const f = blobs.get(path);
      if (opts.ifMatch && f?.etag !== opts.ifMatch) throw new BlobPreconditionFailedError("etag mismatch");
      const etag = `"v${++version}"`;
      blobs.set(path, { text, etag });
      return { etag };
    },
  };
});

// An in-memory stand-in for Upstash Redis's REST API: HMGET and the compare-and-set script.
const redis = new Map<string, Record<string, string>>();
let redisCalls = 0;
const realFetch = globalThis.fetch;
function useRedis() {
  process.env.KV_REST_API_URL = "https://redis.test";
  process.env.KV_REST_API_TOKEN = "t";
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    expect(url).toBe("https://redis.test");
    redisCalls++;
    const cmd = JSON.parse(String(init.body)) as (string | number)[];
    const reply = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } });
    if (cmd[0] === "HMGET") {
      const h = redis.get(String(cmd[1])) ?? {};
      return reply(cmd.slice(2).map((f) => h[String(f)] ?? null));
    }
    if (cmd[0] === "EVAL") {
      const [, , , key, expected, v, d] = cmd.map(String);
      const cur = redis.get(key)?.v;
      if (expected !== "" && cur !== expected) return reply(0);
      redis.set(key, { v, d });
      return reply(1);
    }
    return new Response(JSON.stringify({ error: "unknown" }), { status: 400 });
  }) as typeof fetch;
}

const { handle, pathFor } = await import("../api/progress");

const code = "abcdefghjkmnpqrstuvw";
const state = (n: number) => JSON.stringify({ v: 1, q: {}, log: Array.from({ length: n }, (_, i) => [i, "q", 1, 1, "A", "learn"]), settings: {}, session: null });
const req = (method: string, body?: string, headers: Record<string, string> = {}) =>
  new Request("https://x.test/api/progress", { method, body, headers: { "x-sync-code": code, ...headers } });

beforeEach(() => {
  blobs.clear();
  redis.clear();
  redisCalls = 0;
  blobCalls.get = blobCalls.put = 0;
  process.env.BLOB_READ_WRITE_TOKEN = "blob";
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  globalThis.fetch = realFetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

for (const backend of ["blob", "redis"] as const) {
  describe(`sync server on ${backend}`, () => {
    beforeEach(() => {
      if (backend === "redis") useRedis();
    });

    it("reports no data for a new code, then stores and returns it", async () => {
      const none = await handle(req("GET"));
      expect(none.status).toBe(404);
      expect(none.headers.get("x-sync-store")).toBe(backend);
      const saved = await handle(req("PUT", state(2)));
      expect(saved.status).toBe(200);
      const { etag } = await saved.json();
      const body = await (await handle(req("GET"))).json();
      expect(body.etag).toBe(etag);
      expect(body.state.log.length).toBe(2);
    });

    it("answers 304 when nothing changed since the version the device has", async () => {
      const { etag } = await (await handle(req("PUT", state(1)))).json();
      const same = await handle(req("GET", undefined, { "if-none-match": etag }));
      expect(same.status).toBe(304);
      await handle(req("PUT", state(2), { "if-match": etag }));
      const changed = await handle(req("GET", undefined, { "if-none-match": etag }));
      expect(changed.status).toBe(200);
    });

    it("refuses a write based on an old version, so devices never overwrite each other", async () => {
      const first = await (await handle(req("PUT", state(1)))).json();
      await handle(req("PUT", state(2), { "if-match": first.etag }));
      const stale = await handle(req("PUT", state(3), { "if-match": first.etag }));
      expect(stale.status).toBe(409);
      expect((await (await handle(req("GET"))).json()).state.log.length).toBe(2);
    });

    it("rejects bad codes and things that are not progress", async () => {
      expect((await handle(new Request("https://x.test/api/progress", { headers: { "x-sync-code": "short" } }))).status).toBe(400);
      expect((await handle(req("PUT", "not json"))).status).toBe(400);
      expect((await handle(req("PUT", JSON.stringify({ hello: 1 })))).status).toBe(400);
      expect((await handle(req("DELETE"))).status).toBe(405);
    });
  });
}

describe("switching from Blob to Redis", () => {
  it("copies a code's progress from Blob the first time it's read, then uses only Redis", async () => {
    // saved while the server still used Blob
    await handle(req("PUT", state(3)));
    expect(blobs.size).toBe(1);
    useRedis();
    const first = await (await handle(req("GET"))).json();
    expect(first.state.log.length).toBe(3);
    expect(redis.size).toBe(1);
    const blobReads = blobCalls.get;
    const again = await (await handle(req("GET"))).json();
    expect(again.state.log.length).toBe(3);
    expect(blobCalls.get).toBe(blobReads); // Blob isn't touched any more
    const w = await handle(req("PUT", state(4), { "if-match": again.etag }));
    expect(w.status).toBe(200);
    expect(blobCalls.put).toBe(1); // only the original Blob-era write
  });

  it("an upload based on a Blob-era version is refused once, then works after a read", async () => {
    const { etag } = await (await handle(req("PUT", state(1)))).json();
    useRedis();
    expect((await handle(req("PUT", state(2), { "if-match": etag }))).status).toBe(409);
    const fresh = await (await handle(req("GET"))).json();
    expect((await handle(req("PUT", state(2), { "if-match": fresh.etag }))).status).toBe(200);
  });

  it("keeps each code's progress apart and never stores the code itself", () => {
    expect(pathFor(code)).toMatch(/^progress\/[0-9a-f]{64}\.json$/);
    expect(pathFor(code)).not.toContain(code);
    expect(pathFor(code)).toBe(pathFor(code.toUpperCase()));
  });
});
