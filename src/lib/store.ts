"use client";

import { useSyncExternalStore } from "react";
import type { Engine } from "./engine";

// Progress lives in this browser (localStorage). Settings has Export and Import so it can
// be backed up or moved to another device.

/** Per-question progress. */
export type QS = {
  /** correct first tries toward mastery (TARGET of them masters it) */
  c: number;
  /** attempts */
  n: number;
  /** wrong answers */
  w: number;
  /** last answered (ms) */
  t: number;
  /** first attempt was correct (1) or wrong (0) */
  f?: 0 | 1;
  /** mastered at (ms) */
  m?: number;
  /** passed the final hardening check at (ms) */
  h?: number;
  /** last answer was wrong */
  lw?: 1;
  /** bookmarked */
  bm?: 1;
  /** when the bookmark was last set or cleared (ms), so syncing keeps the latest choice */
  bt?: number;
};

/** [time, question id, correct, ms spent, response, mode] */
export type LogRow = [number, string, 0 | 1, number, string, string];

export type Settings = {
  testDate: string;
  hideTimer: boolean;
  /** calculator panel width as a share of the window (0.25 to 0.7) */
  calcWidth: number;
};

export type Scope = { kind: "all" | "section" | "category" | "sub" | "missed" | "bookmarked" | "harden" | "custom"; value?: string; label: string; start?: string };

export type SavedSession = { scope: Scope; engine: Engine; startedAt: number; answered: number; correct: number };

/**
 * How a recorded first try turned out in the end, keyed by its log row ("time|id"). A miss
 * fixed later without revealing the answer counts as right in stats; one marked for study
 * counts as a miss whatever happened. Mastery never reads these: it only counts clean first tries.
 */
export type Mark = { fixed?: 1; revealed?: 1; study?: 0 | 1; at: number };

export type State = {
  v: 1;
  q: Record<string, QS>;
  log: LogRow[];
  marks?: Record<string, Mark>;
  settings: Settings;
  session: SavedSession | null;
  /** last change on any device (ms); the newer state's settings and session win a sync */
  at?: number;
  /**
   * Generation: a new one starts when progress is erased, so syncing adopts the newer
   * generation instead of merging the old answers back in.
   */
  gen?: string;
  genAt?: number;
};

export const DEFAULT_SETTINGS: Settings = {
  testDate: "2026-12-05",
  hideTimer: false,
  calcWidth: 0.42,
};

const KEY = "sat-bank-v1";

function fresh(): State {
  return { v: 1, q: {}, log: [], marks: {}, settings: { ...DEFAULT_SETTINGS }, session: null };
}

const EMPTY: State = fresh();
let current: State | null = null;
const listeners = new Set<() => void>();

function load(): State {
  if (current) return current;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      current = normalizeState(JSON.parse(raw) as State);
      return current;
    }
  } catch {
    // storage blocked or corrupt: start fresh in memory
  }
  current = fresh();
  return current;
}

function save(s: State) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // quota or private mode: progress stays in memory for this tab
  }
}

function emit() {
  for (const l of listeners) l();
}

export function getState(): State {
  return typeof window === "undefined" ? EMPTY : load();
}

/** Apply a change to a copy of the state, save it, and notify subscribers. */
export function update(fn: (draft: State) => void) {
  const base = load();
  const draft: State = structuredClone(base);
  fn(draft);
  draft.at = Date.now();
  current = draft;
  save(draft);
  emit();
}

function newGen(): Pick<State, "gen" | "genAt" | "at"> {
  const now = Date.now();
  return { gen: Math.random().toString(36).slice(2, 10), genAt: now, at: now };
}

/** Fill in anything an older or partial state is missing. */
export function normalizeState(s: Partial<State>): State {
  return { ...fresh(), ...s, settings: { ...DEFAULT_SETTINGS, ...s.settings } } as State;
}

/** Erase everything. On synced devices too. */
export function resetState() {
  current = { ...fresh(), ...newGen() };
  save(current);
  emit();
}

/** Put in a state that came from syncing, as is (no new timestamp). */
export function applySyncedState(next: State) {
  current = normalizeState(next);
  save(current);
  emit();
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      current = null;
      cb();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

export function useStore(): State {
  return useSyncExternalStore(subscribe, getState, () => EMPTY);
}

/** True after hydration, so pages can avoid flashing empty progress. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

export function qs(state: State, id: string): QS {
  return state.q[id] ?? { c: 0, n: 0, w: 0, t: 0 };
}
