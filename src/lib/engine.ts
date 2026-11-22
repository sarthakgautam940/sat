// The mastery scheduler.
//
// A question is mastered after 5 correct answers. A wrong answer never counts toward the 5.
// Spacing is enforced on every try, across sessions: a question is never shown again until
// enough other questions have been answered since its last try (or about an hour has passed,
// which the caller's wait hook decides):
//
//   after a wrong answer        2 other questions
//   after correct answer 1..4   3, 5, 8, then 12 other questions
//
// So a question never comes back early, whether by clicking it again, starting a new
// session, or being the only question left in a small set. A session keeps a small working
// set and grows it only when nothing in it is due, so repeats still come back near. When
// everything left in the set is waiting, the session mixes in a question from outside the
// set (the extra hook) instead of repeating one early. All state is plain data, so a session
// survives reloads.

export const TARGET = 5;
export const WINDOW = 6;
/** Steps until the next showing after correct answer number k (index = corrects so far). */
export const GAP_CORRECT = [0, 4, 6, 9, 13, 13];
/** Steps until the next showing after a wrong answer. */
export const GAP_WRONG = 3;

/** Other questions that must be answered in between before a question may be tried again. */
export function gapAfter(ok: boolean, correctSoFar: number): number {
  return (ok ? GAP_CORRECT[Math.min(Math.max(correctSoFar, 1), GAP_CORRECT.length - 1)] : GAP_WRONG) - 1;
}

export type Slot = {
  id: string;
  /** Step at which the question may show again. */
  due: number;
  /** Correct answers still needed in this session. */
  left: number;
  /** Times shown in this session. */
  seen: number;
  /** Mixed in from outside the set while the set's questions were waiting. */
  filler?: boolean;
};

export type Engine = {
  pool: string[];
  active: Slot[];
  step: number;
  recent: string[];
  done: string[];
  window: number;
};

export type Need = (id: string) => number;

export type Hooks = {
  /** Correct answers the question still needs (0 when it is done). */
  need: Need;
  /** Answers to other questions still needed before it may be tried again (0 when ready). */
  wait?: (id: string) => number;
  /** Questions outside the set, in order, to mix in while everything in the set is waiting. */
  extra?: () => string[];
};

function hooksOf(h: Hooks | Need): Hooks {
  return typeof h === "function" ? { need: h } : h;
}

let rand: () => number = Math.random;
/** Tests can make the shuffle repeatable. */
export function setRandom(fn: () => number) {
  rand = fn;
}

/** Start a session. pool is in priority order; need(id) is how many correct answers it still needs. */
export function createEngine(pool: string[], hooks: Hooks | Need, window = WINDOW): Engine {
  const { need } = hooksOf(hooks);
  const seen = new Set<string>();
  const clean = pool.filter((id) => {
    if (seen.has(id) || need(id) <= 0) return false;
    seen.add(id);
    return true;
  });
  return { pool: clean, active: [], step: 0, recent: [], done: [], window };
}

function fill(e: Engine, h: Hooks, limit: number) {
  while (e.active.length < limit && e.pool.length) {
    const id = e.pool.shift()!;
    const left = h.need(id);
    if (left > 0) e.active.push({ id, due: e.step + (h.wait?.(id) ?? 0), left, seen: 0 });
    else e.done.push(id);
  }
}

/**
 * Bring the working set in line with saved progress, which is the authority: drop questions
 * that are done, hold back any that were tried too recently (in another session, say), and
 * release any whose time has passed.
 */
function sync(e: Engine, h: Hooks) {
  for (let i = e.active.length - 1; i >= 0; i--) {
    const s = e.active[i];
    const left = h.need(s.id);
    if (left <= 0) {
      e.active.splice(i, 1);
      e.done.push(s.id);
      continue;
    }
    s.left = left;
    if (!h.wait) continue;
    const w = h.wait(s.id);
    s.due = w > 0 ? Math.max(s.due, e.step + w) : Math.min(s.due, e.step);
  }
}

/** Mix in the first ready question from outside the set. */
function addFiller(e: Engine, h: Hooks, recent: string[]): Slot | null {
  if (!h.extra) return null;
  const taken = new Set([...e.active.map((s) => s.id), ...e.pool, ...e.done]);
  for (const id of h.extra()) {
    if (taken.has(id) || recent.includes(id)) continue;
    const left = h.need(id);
    if (left <= 0 || (h.wait?.(id) ?? 0) > 0) continue;
    const slot: Slot = { id, due: e.step, left, seen: 0, filler: true };
    e.active.push(slot);
    return slot;
  }
  return null;
}

/** Questions of the set itself that still need work (mixed-in questions not counted). */
export function remainingInSet(e: Engine): number {
  return e.pool.length + e.active.filter((s) => !s.filler).length;
}

/**
 * Choose the next question. Returns null when the set is complete, or when everything left
 * in it is still waiting and nothing can be mixed in (remainingInSet tells the two apart).
 * Never returns a question before its spacing is met. Mutates e.
 */
export function nextQuestion(e: Engine, hooks: Hooks | Need): string | null {
  const h = hooksOf(hooks);
  sync(e, h);
  fill(e, h, e.window);
  if (remainingInSet(e) === 0) return null;
  const isDue = (s: Slot) => s.due <= e.step;
  // a fresh session opens on the first ready question in its order, never a shuffled one
  if (e.step === 0 && e.active.every((s) => s.seen === 0)) {
    const first = e.active.find((s) => !s.filler && isDue(s));
    if (first) return first.id;
  }

  // Never repeat the last question; avoid the last two when there is room.
  const block = e.active.length >= 3 ? 2 : e.active.length === 2 ? 1 : 0;
  const recent = block ? e.recent.slice(-block) : [];
  const ready = () => e.active.filter((s) => isDue(s) && !recent.includes(s.id));

  let due = ready();
  // Nothing is due: bring in more of the set, as many as it takes.
  while (!due.length && e.pool.length) {
    fill(e, h, e.active.length + 1);
    due = ready();
  }
  // Still nothing: mix in a question from outside the set rather than repeat one early.
  if (!due.length) {
    const f = addFiller(e, h, recent);
    if (f) due = [f];
  }
  if (!due.length) return null;

  let pool = due;
  // questions already in rotation (a miss coming back) go before new ones
  const reviews = pool.filter((s) => s.seen > 0);
  if (reviews.length) pool = reviews;
  pool.sort((a, b) => a.due - b.due || Number(!!a.filler) - Number(!!b.filler) || a.seen - b.seen || b.left - a.left);
  // Among questions that came due at about the same time, pick at random so the order
  // never settles into a pattern you could learn instead of the questions. The set's own
  // questions go before mixed-in ones.
  const near = pool.filter((s) => s.due <= pool[0].due + 2);
  const own = near.filter((s) => !s.filler);
  const pick = own.length ? own : near;
  return pick[Math.floor(rand() * pick.length)].id;
}

/**
 * Put a chosen question (the tile that was clicked) at the front of the working set. If it
 * is ready the caller shows it first; if it was tried too recently the caller shows the last
 * try instead, and the question waits its turn here like any other.
 */
export function startWith(e: Engine, id: string, hooks: Hooks | Need): string {
  const h = hooksOf(hooks);
  fill(e, h, e.window);
  const i = e.active.findIndex((s) => s.id === id);
  if (i > 0) e.active.unshift(...e.active.splice(i, 1));
  if (i < 0) {
    const j = e.pool.indexOf(id);
    if (j >= 0) e.pool.splice(j, 1);
    const left = h.need(id);
    if (left > 0) e.active.unshift({ id, due: e.step + (h.wait?.(id) ?? 0), left, seen: 0 });
  }
  return id;
}

/** Record an answer for id. newLeft is how many correct answers it still needs afterward. */
export function recordAnswer(e: Engine, id: string, ok: boolean, correctSoFar: number, newLeft: number): Engine {
  e.step += 1;
  e.recent.push(id);
  if (e.recent.length > 4) e.recent.shift();
  const i = e.active.findIndex((s) => s.id === id);
  if (i < 0) return e;
  const slot = e.active[i];
  slot.seen += 1;
  slot.left = newLeft;
  if (newLeft <= 0) {
    e.active.splice(i, 1);
    e.done.push(id);
    return e;
  }
  slot.due = e.step + gapAfter(ok, correctSoFar);
  return e;
}

export function remaining(e: Engine): number {
  return e.pool.length + e.active.length;
}
