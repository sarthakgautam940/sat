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
// saved session come from whichever device changed last. Erasing progress starts a new
// generation, which the other devices adopt instead of merging the old answers back in.
//
// Progress is saved per web address, and the site has several (every deployment gets its
// own). So the site keeps one main address: opening any other one moves that address's
// progress to the main one through the sync server, then goes there. Updates never touch
// saved progress.
//
// Storage operations are kept to a minimum (the free storage tiers count them): progress is
// downloaded when the app opens and, after that, only when coming back to it after a while;
// changes are uploaded at most every few minutes while practicing and when leaving, and an
// upload doesn't download first unless another device changed something in between. What
// was last synced is remembered, so unsent changes survive closing the app. The cadence is
// quicker when the server says it stores progress in Redis, which allows far more.

const CODE_KEY = "sat-sync-code";
/** The main address (host, with port if any), set at build time; empty in local dev. */
const CANONICAL = process.env.NEXT_PUBLIC_CANONICAL_HOST || "";
/** Hosts ending in this are the site's other addresses (every Vercel deployment and alias). */
const SITE_SUFFIX = process.env.NEXT_PUBLIC_SITE_SUFFIX || ".vercel.app";
const API = "/api/progress";
const META_KEY = "sat-sync-meta";
/**
 * push: how long after a change to upload it while practicing. pull: how long after a download
 * before coming back to the app downloads again. leave: the least time between uploads made
 * on leaving the app. Blob's free tier allows only 2,000 writes a month, so it's frugal;
 * Redis allows hundreds of thousands, so it's close to live.
 */
const CADENCE = {
  blob: { push: 15 * 60 * 1000, pull: 15 * 60 * 1000, leave: 5 * 60 * 1000 },
  redis: { push: 60 * 1000, pull: 0, leave: 0 },
};
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

/** A fingerprint of a state's progress, to tell whether anything changed since the last sync. */
function fingerprint(s: State): string {
  const m = Object.values(s.marks ?? {});
  return `${s.gen ?? ""}|${s.at ?? 0}|${s.log.length}|${bookmarkKey(s)}|${m.length}:${Math.max(0, ...m.map((x) => x.at))}`;
}

/** What this device last synced with the server, for one code: the server's version and the state's fingerprint. */
type Meta = { code: string; etag: string | null; fp: string };

function readMeta(code: string): Meta | null {
  try {
    const m = JSON.parse(window.localStorage.getItem(META_KEY) ?? "null") as Meta | null;
    return m && m.code === code ? m : null;
  } catch {
    return null;
  }
}

function writeMeta(m: Meta | null) {
  try {
    if (m) window.localStorage.setItem(META_KEY, JSON.stringify(m));
    else window.localStorage.removeItem(META_KEY);
  } catch {
    // storage blocked: sync still works, just less frugally
  }
}

/** Whether this device has changes the server hasn't seen. */
function unsent(code: string): boolean {
  return readMeta(code)?.fp !== fingerprint(getState());
}

/** Which store the server uses (it says so on every reply); sets how often to sync. */
let store: "blob" | "redis" = "blob";
let lastPull = 0;
let lastPush = 0;

function noteStore(res: Response) {
  const s = res.headers.get("x-sync-store");
  if (s === "redis" || s === "blob") store = s;
}

/**
 * Sync with the server. pull: download first (only what changed since the last sync, if
 * anything). Then upload if this device has changes the server hasn't seen, conditional on
 * the version last seen; if another device wrote in between, download theirs, merge, and
 * upload again.
 */
async function run(code: string, join: boolean, pull: boolean) {
  let mustRead = join;
  for (let attempt = 0; attempt < 4; attempt++) {
    const meta = readMeta(code);
    let etag = meta?.etag ?? null;
    const changed = unsent(code);
    // With changes of its own, this device uploads straight away (the upload is refused if
    // another device wrote since, and then it reads). Otherwise it reads only what changed.
    if (mustRead || !meta || (pull && !changed)) {
      const conditional = !mustRead && !!meta && !!etag && !changed;
      const res = await fetch(API, { headers: { "x-sync-code": code, ...(conditional && etag ? { "if-none-match": etag } : {}) }, cache: "no-store" });
      noteStore(res);
      lastPull = Date.now();
      if (res.status !== 304) {
        const body = await readJson(res);
        if (res.ok && body?.state) {
          const remote = normalizeState(body.state);
          const local = getState();
          const merged = mergeStates(local, remote, join);
          if (!sameState(merged, local)) apply(merged);
          etag = body.etag ?? null;
          // what the server has is now in this device's progress
          writeMeta({ code, etag, fp: sameState(merged, remote) ? fingerprint(getState()) : fingerprint(remote) });
        } else if (res.status === 404 && body?.error === "none") {
          etag = null;
          writeMeta({ code, etag: null, fp: "" });
        } else {
          throw new SyncError(explain(res, body));
        }
      }
      join = false;
      mustRead = false;
    }
    if (!unsent(code)) return;
    const local = getState();
    const put = await fetch(API, {
      method: "PUT",
      headers: { "x-sync-code": code, "content-type": "application/json", ...(etag ? { "if-match": etag } : {}) },
      body: JSON.stringify(local),
    });
    noteStore(put);
    if (put.status === 409) {
      // another device wrote first: download theirs, merge, and upload again
      mustRead = true;
      continue;
    }
    if (!put.ok) throw new SyncError(explain(put, await readJson(put)));
    const body = await readJson(put);
    writeMeta({ code, etag: body?.etag ?? null, fp: fingerprint(local) });
    lastPush = Date.now();
    return;
  }
  throw new SyncError("Another device kept writing at the same moment. It will try again shortly.");
}

// ---------------------------------------------------------------- the agent

let applying = false;
let running: Promise<void> | null = null;
let again = false;
let againPull = false;
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

/**
 * Sync now. pull (the default) downloads first; pull false only uploads unsent changes.
 * Safe to call any time; overlapping calls are folded into one more pass.
 */
export function syncNow(join = false, pull = true): Promise<void> {
  const code = status.code;
  if (!code) return Promise.resolve();
  if (running) {
    again = true;
    againPull = againPull || pull;
    return running;
  }
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  setStatus({ state: "syncing" });
  running = run(code, join, pull)
    .then(() => setStatus({ state: "synced", at: Date.now(), message: "" }))
    .catch((e: unknown) => {
      setStatus({ state: "error", message: e instanceof SyncError ? e.message : "Couldn't reach the sync server. Progress is still saved on this device, and it will sync when you're back online." });
    })
    .finally(() => {
      running = null;
      if (again) {
        const p = againPull;
        again = false;
        againPull = false;
        void syncNow(false, p);
      } else if (status.code && unsent(status.code)) schedule();
    });
  return running;
}

/** Upload unsent changes a little later (changes made meanwhile go in the same upload). */
function schedule(delay = CADENCE[store].push) {
  if (!status.code) return;
  if (timer) {
    // an upload is already coming; bring it forward if this one is sooner
    if (delay >= CADENCE[store].push) return;
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = null;
    void syncNow(false, false);
  }, Math.max(0, delay));
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
  writeMeta(null);
  if (timer) clearTimeout(timer);
  timer = null;
  setStatus({ ...OFF });
}

/** A link that connects another device: the code rides in the fragment, never sent to a server. */
export function syncLink(code: string): string {
  return `${window.location.origin}/#sync=${code}`;
}

/** Combine progress handed over from another address into this one, keeping this device's own code if it has one. */
async function absorb(input: string) {
  const code = cleanCode(input);
  if (!validCode(code)) return;
  const own = readCode();
  if (!own || own === code) {
    await joinSync(code);
    return;
  }
  setStatus({ code: own, state: "syncing" });
  try {
    const res = await fetch(API, { headers: { "x-sync-code": code }, cache: "no-store" });
    const body = await readJson(res);
    if (res.ok && body?.state) {
      const local = getState();
      const merged = { ...mergeStates(local, normalizeState(body.state), true), gen: local.gen, genAt: local.genAt };
      if (!sameState(merged, local)) apply(merged);
    }
  } catch {
    // the server is unreachable: the progress stays at the other address for next time
  }
  await syncNow();
}

/** Whether this page is on one of the site's other Vercel addresses. */
function onOtherAddress(): boolean {
  return !!CANONICAL && window.location.host !== CANONICAL && window.location.hostname.endsWith(SITE_SUFFIX);
}

/** Move this address's progress to the main address and go there. False if it couldn't. */
async function moveToMainAddress(): Promise<boolean> {
  const main = `${window.location.protocol}//${CANONICAL}${window.location.pathname}${window.location.search}`;
  const s = getState();
  const hasProgress = s.log.length > 0 || Object.values(s.q).some((q) => q.bm);
  if (!hasProgress) {
    window.location.replace(main + window.location.hash);
    return true;
  }
  let code = readCode();
  if (!code) {
    code = newCode();
    writeCode(code);
  }
  setStatus({ code });
  await syncNow();
  if (status.state !== "synced") return false;
  window.location.replace(`${main}#handoff=${code}`);
  return true;
}

/** Start the agent once per page load. */
export function startSyncAgent() {
  if (started) return;
  started = true;
  if (onOtherAddress()) {
    void moveToMainAddress().then((moved) => {
      if (!moved) begin();
    });
    return;
  }
  begin();
}

function begin() {
  // a link from another device (#sync=<code>), or progress handed over from another address (#handoff=<code>)
  const m = /(?:^#|&)(sync|handoff)=([a-z0-9-]+)/i.exec(window.location.hash);
  if (m) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
    void (m[1] === "sync" ? joinSync(m[2]) : absorb(m[2]));
  } else {
    const code = readCode();
    if (code) {
      setStatus({ code });
      void syncNow();
    }
  }
  // a change here: upload it a little later, together with whatever else changes meanwhile
  subscribe(() => {
    if (applying || !status.code) return;
    schedule();
  });
  document.addEventListener("visibilitychange", () => {
    if (!status.code) return;
    if (document.visibilityState === "hidden") {
      // leaving: send what this device did, so another device picks it up
      if (unsent(status.code)) {
        const wait = lastPush + CADENCE[store].leave - Date.now();
        // uploaded only moments ago: send these as soon as the gap is up instead
        if (wait <= 0) void syncNow(false, false);
        else schedule(wait);
      }
    } else if (Date.now() - lastPull >= CADENCE[store].pull) {
      // back after a while: pick up what other devices did
      void syncNow();
    }
  });
  window.addEventListener("pagehide", () => {
    if (status.code && unsent(status.code)) void syncNow(false, false);
  });
  window.addEventListener("online", () => {
    if (status.code) void syncNow();
  });
}
