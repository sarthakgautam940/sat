"use client";

import { useSyncExternalStore } from "react";
import { replayLog } from "./progress";
import { applySyncedState, getState, normalizeState, subscribe, type LogRow, type Mark, type QS, type State } from "./store";

// Sync across devices.
//
// Progress stays in this browser first (it works offline) and is copied to the server under
// a sync code. Every device that has the code shares the same progress. Two devices never
// overwrite each other: their answer logs are combined and every question's progress is
// rebuilt from the combined log, so an answer made anywhere is never lost. Settings and the
// saved session come from whichever device changed last. Erasing progress (or importing a
// file) starts a new generation, which the other devices adopt instead of merging the old
// answers back in.
//
// To stay well inside the free storage tier, changes are sent at most every few minutes
// while you practice, and right away when the tab is hidden or the app is closed.

const CODE_KEY = "sat-sync-code";
const API = "/api/progress";
const PUSH_EVERY_MS = 4 * 60 * 1000;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

// ---------------------------------------------------------------- merging (pure)

function bookmarkKey(s: State): string {
  return Object.entries(s.q)
    .filter(([, q]) => q.bm)
    .map(([id]) => id)
    .sort()
    .join(",");
}

/** Whether two states hold the same progress (cheap: they share history up to these markers). */
function marksKey(s: State): string {
  const m = Object.values(s.marks ?? {});
  return `${m.length}:${Math.max(0, ...m.map((x) => x.at))}`;
}

export function sameState(a: State, b: State): boolean {
  return (a.gen ?? "") === (b.gen ?? "") && (a.at ?? 0) === (b.at ?? 0) && a.log.length === b.log.length && bookmarkKey(a) === bookmarkKey(b) && marksKey(a) === marksKey(b);
}

/**
 * Combine this device's progress with the server's. join: this device is being connected
 * with a code, so its answers are kept even if the server's progress was erased before.
 */
export function mergeStates(local: State, remote: State, join = false): State {
  if (!join && (local.gen ?? "") !== (remote.gen ?? "")) {
    // one side erased or imported: the newer generation wins outright
    return (remote.genAt ?? 0) >= (local.genAt ?? 0) ? remote : local;
  }
  const newer = (remote.at ?? 0) > (local.at ?? 0) ? remote : local;
  const seen = new Set<string>();
  const log: LogRow[] = [];
  for (const row of [...remote.log, ...local.log]) {
    const key = `${row[0]}|${row[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    log.push(row);
  }
  log.sort((x, y) => x[0] - y[0]);
  // how each first try turned out: the later note wins
  const marks: Record<string, Mark> = { ...(remote.marks ?? {}) };
  for (const [k, m] of Object.entries(local.marks ?? {})) if (!marks[k] || m.at > marks[k].at) marks[k] = m;
  const q: Record<string, QS> = replayLog(log, marks);
  // bookmarks: the later change wins; without times (older data) a bookmark on either side stands
  for (const id of new Set([...Object.keys(local.q), ...Object.keys(remote.q)])) {
    const l = local.q[id];
    const r = remote.q[id];
    const lt = l?.bt ?? 0;
    const rt = r?.bt ?? 0;
    const bm = lt === rt ? !!(l?.bm || r?.bm) : lt > rt ? !!l?.bm : !!r?.bm;
    const bt = Math.max(lt, rt);
    if (!bm && !bt) continue;
    const base = q[id] ?? { c: 0, n: 0, w: 0, t: 0 };
    q[id] = { ...base, ...(bm ? { bm: 1 as const } : {}), ...(bt ? { bt } : {}) };
  }
  return {
    v: 1,
    q,
    log,
    marks,
    settings: newer.settings,
    session: newer.session,
    at: Math.max(local.at ?? 0, remote.at ?? 0),
    gen: join ? remote.gen : local.gen,
    genAt: join ? remote.genAt : local.genAt,
  };
}

// ---------------------------------------------------------------- codes

export function newCode(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** Accepts the code as typed: any case, with or without dashes and spaces. */
export function cleanCode(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function formatCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

export function validCode(code: string): boolean {
  return /^[a-z0-9]{20,64}$/.test(code);
}

function readCode(): string | null {
  try {
    const c = window.localStorage.getItem(CODE_KEY);
    return c && validCode(c) ? c : null;
  } catch {
    return null;
  }
}

function writeCode(code: string | null) {
  try {
    if (code) window.localStorage.setItem(CODE_KEY, code);
    else window.localStorage.removeItem(CODE_KEY);
  } catch {
    // storage blocked: sync stays on for this visit only
  }
}

// ---------------------------------------------------------------- status

export type SyncStatus = {
  code: string | null;
  state: "off" | "syncing" | "synced" | "error";
  /** last successful sync (ms) */
  at: number;
  message: string;
};

let status: SyncStatus = { code: null, state: "off", at: 0, message: "" };
const statusListeners = new Set<() => void>();
const OFF: SyncStatus = { code: null, state: "off", at: 0, message: "" };

function setStatus(next: Partial<SyncStatus>) {
  status = { ...status, ...next };
  for (const l of statusListeners) l();
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (cb) => {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    () => status,
    () => OFF,
  );
}

// ---------------------------------------------------------------- talking to the server

class SyncError extends Error {}

function explain(res: Response, body: { error?: string } | null): string {
  if (body?.error === "not-configured") return "Sync isn't set up on the server yet. Connect a Blob store to the project in Vercel, then redeploy.";
  if (body?.error === "suspended") return "The sync storage is paused (its free monthly limit was reached). Progress is still saved on this device.";
  if (res.status === 404 || res.status === 405) return "This copy of the site has no sync server. Progress is still saved on this device.";
  return `The sync server answered ${res.status}. Progress is still saved on this device.`;
}

async function readJson(res: Response): Promise<{ error?: string; etag?: string; state?: State } | null> {
  if (!(res.headers.get("content-type") ?? "").includes("json")) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Pull, merge, and push if anything changed. Retries when another device wrote in between. */
async function run(code: string, join: boolean) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API, { headers: { "x-sync-code": code }, cache: "no-store" });
    const body = await readJson(res);
    let remote: State | null = null;
    let etag: string | undefined;
    if (res.ok && body?.state) {
      remote = normalizeState(body.state);
      etag = body.etag;
    } else if (!(res.status === 404 && body?.error === "none")) {
      throw new SyncError(explain(res, body));
    }
    const local = getState();
    const merged = remote ? mergeStates(local, remote, join) : local;
    if (!sameState(merged, local)) apply(merged);
    if (remote && sameState(merged, remote)) return;
    const put = await fetch(API, {
      method: "PUT",
      headers: { "x-sync-code": code, "content-type": "application/json", ...(etag ? { "if-match": etag } : {}) },
      body: JSON.stringify(merged),
    });
    if (put.status === 409) continue; // another device wrote first: merge with theirs and try again
    if (!put.ok) throw new SyncError(explain(put, await readJson(put)));
    return;
  }
  throw new SyncError("Another device kept writing at the same moment. It will try again shortly.");
}

// ---------------------------------------------------------------- the agent

let applying = false;
let dirty = false;
let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function apply(next: State) {
  applying = true;
  try {
    applySyncedState(next);
  } finally {
    applying = false;
  }
}

/** Sync now. Safe to call any time; overlapping calls are folded into one more pass. */
export function syncNow(join = false): Promise<void> {
  const code = status.code;
  if (!code) return Promise.resolve();
  if (running) {
    again = true;
    return running;
  }
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  setStatus({ state: "syncing" });
  const wasDirty = dirty;
  dirty = false;
  running = run(code, join)
    .then(() => setStatus({ state: "synced", at: Date.now(), message: "" }))
    .catch((e: unknown) => {
      dirty = dirty || wasDirty;
      setStatus({ state: "error", message: e instanceof SyncError ? e.message : "Couldn't reach the sync server. Progress is still saved on this device, and it will sync when you're back online." });
    })
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        void syncNow();
      } else if (dirty) schedule();
    });
  return running;
}

function schedule() {
  if (timer || !status.code) return;
  timer = setTimeout(() => {
    timer = null;
    void syncNow();
  }, PUSH_EVERY_MS);
}

/** Turn sync on with a new code; this device's progress becomes the shared copy. */
export function startNewSync(): Promise<void> {
  const code = newCode();
  writeCode(code);
  setStatus({ code, state: "syncing", message: "" });
  return syncNow();
}

/** Connect this device with a code from another one. Both devices' answers are kept. */
export function joinSync(input: string): Promise<void> {
  const code = cleanCode(input);
  if (!validCode(code)) {
    setStatus({ state: "error", message: "That code doesn't look right. It's 20 letters and numbers." });
    return Promise.resolve();
  }
  writeCode(code);
  setStatus({ code, state: "syncing", message: "" });
  return syncNow(true);
}

/** Stop syncing on this device. Progress stays here, and on the server for other devices. */
export function stopSync() {
  writeCode(null);
  if (timer) clearTimeout(timer);
  timer = null;
  dirty = false;
  setStatus({ ...OFF });
}

/** A link that connects another device: the code rides in the fragment, never sent to a server. */
export function syncLink(code: string): string {
  return `${window.location.origin}/#sync=${code}`;
}

/** Start the agent once per page load. */
export function startSyncAgent() {
  if (started) return;
  started = true;
  // a link from another device: #sync=<code>
  const m = /(?:^#|&)sync=([a-z0-9-]+)/i.exec(window.location.hash);
  if (m) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    void joinSync(m[1]);
  } else {
    const code = readCode();
    if (code) {
      setStatus({ code });
      void syncNow();
    }
  }
  subscribe(() => {
    if (applying || !status.code) return;
    dirty = true;
    schedule();
  });
  document.addEventListener("visibilitychange", () => {
    if (!status.code) return;
    // coming back: pick up what other devices did; leaving: send what this one did
    if (document.visibilityState === "visible" || dirty) void syncNow();
  });
  window.addEventListener("pagehide", () => {
    if (status.code && dirty) void syncNow();
  });
  window.addEventListener("online", () => {
    if (status.code) void syncNow();
  });
}
