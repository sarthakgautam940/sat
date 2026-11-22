import { beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory stand-in for Vercel Blob with the same conditional-write behavior.
const files = new Map<string, { text: string; etag: string }>();
let version = 0;
vi.mock("@vercel/blob", () => {
  class BlobError extends Error {}
  class BlobPreconditionFailedError extends BlobError {}
  class BlobNotFoundError extends BlobError {}
  class BlobStoreSuspendedError extends BlobError {}
  return {
    BlobPreconditionFailedError,
    BlobNotFoundError,
    BlobStoreSuspendedError,
    get: async (path: string) => {
      const f = files.get(path);
      if (!f) return null;
      return { statusCode: 200, stream: new Blob([f.text]).stream(), blob: { etag: f.etag } };
    },
    put: async (path: string, text: string, opts: { ifMatch?: string }) => {
      const f = files.get(path);
      if (opts.ifMatch && f?.etag !== opts.ifMatch) throw new BlobPreconditionFailedError("etag mismatch");
      const etag = `"v${++version}"`;
      files.set(path, { text, etag });
      return { etag };
    },
  };
});

const { handle, pathFor } = await import("../api/progress");

const code = "abcdefghjkmnpqrstuvw";
const state = (n: number) => JSON.stringify({ v: 1, q: {}, log: Array.from({ length: n }, (_, i) => [i, "q", 1, 1, "A", "learn"]), settings: {}, session: null });
const req = (method: string, body?: string, headers: Record<string, string> = {}) =>
  new Request("https://x.test/api/progress", { method, body, headers: { "x-sync-code": code, ...headers } });

describe("sync server", () => {
  beforeEach(() => files.clear());

  it("reports no data for a new code, then stores and returns it", async () => {
    const none = await handle(req("GET"));
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: "none" });
    const saved = await handle(req("PUT", state(2)));
    expect(saved.status).toBe(200);
    const { etag } = await saved.json();
    const got = await handle(req("GET"));
    const body = await got.json();
    expect(body.etag).toBe(etag);
    expect(body.state.log.length).toBe(2);
  });

  it("refuses a write based on an old version, so devices never overwrite each other", async () => {
    const first = await (await handle(req("PUT", state(1)))).json();
    await handle(req("PUT", state(2), { "if-match": first.etag }));
    const stale = await handle(req("PUT", state(3), { "if-match": first.etag }));
    expect(stale.status).toBe(409);
    expect((await (await handle(req("GET"))).json()).state.log.length).toBe(2);
  });

  it("keeps each code's progress apart and never stores the code itself", async () => {
    expect(pathFor(code)).toMatch(/^progress\/[0-9a-f]{64}\.json$/);
    expect(pathFor(code)).not.toContain(code);
    expect(pathFor(code)).toBe(pathFor(code.toUpperCase()));
    expect(pathFor("other-code-0123456789".replace(/-/g, ""))).not.toBe(pathFor(code));
  });

  it("rejects bad codes and things that are not progress", async () => {
    expect((await handle(new Request("https://x.test/api/progress", { headers: { "x-sync-code": "short" } }))).status).toBe(400);
    expect((await handle(req("PUT", "not json"))).status).toBe(400);
    expect((await handle(req("PUT", JSON.stringify({ hello: 1 })))).status).toBe(400);
    expect((await handle(req("DELETE"))).status).toBe(405);
  });
});
