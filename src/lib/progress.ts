"use client";

import { gapAfter, TARGET } from "./engine";
import { qs, update, type LogRow, type QS, type State } from "./store";

export type Mode = "learn" | "harden";

/** How many correct answers a question still needs in this mode. */
export function needFor(state: State, id: string, mode: Mode): number {
  const q = qs(state, id);
  if (mode === "harden") return q.c >= TARGET ? (q.h ? 0 : 1) : TARGET - q.c;
  return Math.max(0, TARGET - q.c);
}

/**
 * Save one answer. Learning: a correct answer adds one toward the five. Hardening (the
 * final check on mastered questions): a correct answer passes the check; a wrong one drops
 * the question back to 3 of 5, so it has to be earned again.
 */
export function recordAttempt(id: string, ok: boolean, ms: number, response: string, mode: Mode) {
  const now = Date.now();
  update((s) => {
    s.q[id] = applyAttempt(qs(s, id), ok, mode, now);
    s.log.push([now, id, ok ? 1 : 0, Math.round(ms), response, mode]);
  });
}

/** One answer's effect on a question's progress. Pure, so progress can be rebuilt from the log. */
export function applyAttempt(prev: QS, ok: boolean, mode: string, at: number): QS {
  const q = { ...prev };
  q.n += 1;
  q.t = at;
  if (q.f === undefined) q.f = ok ? 1 : 0;
  if (ok) {
    delete q.lw;
    if (mode === "harden" && q.c >= TARGET) {
      q.h = at;
    } else {
      q.c = Math.min(TARGET, q.c + 1);
      if (q.c >= TARGET) {
        q.m = q.m ?? at;
        if (mode === "harden") q.h = at;
      }
    }
  } else {
    q.w += 1;
    q.lw = 1;
    if (mode === "harden" && q.c >= TARGET) {
      q.c = 3;
      delete q.m;
      delete q.h;
    }
  }
  return q;
}

/** Every question's progress, rebuilt from the answer log (bookmarks are not in the log). */
export function replayLog(log: LogRow[]): Record<string, QS> {
  const out: Record<string, QS> = {};
  for (const [at, id, ok, , , mode] of log) out[id] = applyAttempt(out[id] ?? { c: 0, n: 0, w: 0, t: 0 }, ok === 1, mode, at);
  return out;
}

export function toggleBookmark(id: string) {
  update((s) => {
    const q = { ...qs(s, id) };
    if (q.bm) delete q.bm;
    else q.bm = 1;
    q.bt = Date.now();
    s.q[id] = q;
  });
}

/** A question also becomes ready again once this much time has passed since its last try. */
export const READY_AFTER_MS = 60 * 60 * 1000;

export type LastTry = { index: number; at: number; ok: boolean; response: string; ms: number };

export type Readiness = {
  /** The question's last try, or null if it was never tried. */
  last: (id: string) => LastTry | null;
  /** Answers to other questions still needed before it may be tried again (0 when ready). */
  wait: (id: string) => number;
  /** Time until it is ready anyway (0 when ready). */
  msLeft: (id: string) => number;
};

/**
 * How soon each question may be tried again, from the answer log, so it holds across
 * sessions, reloads, and tile clicks: after a try, a question needs gapAfter() other answers
 * in between (2 after a miss; 3, 5, 8, then 12 after correct answers) or an hour.
 */
export function readiness(state: State, now: number): Readiness {
  const tries = new Map<string, LastTry>();
  state.log.forEach(([at, id, ok, ms, response], index) => tries.set(id, { index, at, ok: ok === 1, response, ms }));
  const total = state.log.length;
  const left = (t: LastTry) => Math.max(0, t.at + READY_AFTER_MS - now);
  return {
    last: (id) => tries.get(id) ?? null,
    wait: (id) => {
      const t = tries.get(id);
      if (!t || left(t) === 0) return 0;
      return Math.max(0, gapAfter(t.ok, qs(state, id).c) - (total - 1 - t.index));
    },
    msLeft: (id) => {
      const t = tries.get(id);
      return t ? left(t) : 0;
    },
  };
}
