import { describe, expect, it } from "vitest";
import { createEngine, gapAfter, nextQuestion, recordAnswer, remainingInSet, setRandom, startWith, TARGET, type Engine, type Hooks } from "./engine";

let seed = 42;
setRandom(() => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
});

/**
 * A study history shared across sessions, like the saved answer log: wait() is the number of
 * other answers still needed before a question may be tried again.
 */
function history() {
  const counts = new Map<string, number>();
  const last = new Map<string, { i: number; ok: boolean }>();
  const log: string[] = [];
  const need = (id: string) => TARGET - (counts.get(id) ?? 0);
  const wait = (id: string) => {
    const l = last.get(id);
    if (!l) return 0;
    return Math.max(0, gapAfter(l.ok, counts.get(id) ?? 0) - (log.length - 1 - l.i));
  };
  const answer = (e: Engine, id: string, ok: boolean) => {
    const c = (counts.get(id) ?? 0) + (ok ? 1 : 0);
    counts.set(id, c);
    log.push(id);
    last.set(id, { i: log.length - 1, ok });
    recordAnswer(e, id, ok, c, TARGET - c);
  };
  return { counts, log, need, wait, answer };
}

const ids = (n: number, p = "q") => Array.from({ length: n }, (_, i) => `${p}${i}`);

function simulate(n: number, accuracy: (id: string, k: number) => boolean, steps = 6000) {
  const h = history();
  const fillers = ids(300, "x");
  const hooks: Hooks = { need: h.need, wait: h.wait, extra: () => fillers };
  const e = createEngine(ids(n), hooks);
  const shown: string[] = [];
  for (let t = 0; t < steps; t++) {
    const id = nextQuestion(e, hooks);
    if (!id) break;
    shown.push(id);
    h.answer(e, id, accuracy(id, shown.length));
  }
  return { shown, counts: h.counts, e, h };
}

/** For every repeat, the number of other questions in between must meet the spacing. */
function spacingViolations(shown: string[], okAt: (i: number) => boolean, countAfter: (i: number) => number) {
  const last = new Map<string, number>();
  const bad: string[] = [];
  shown.forEach((id, i) => {
    const j = last.get(id);
    if (j !== undefined && i - j - 1 < gapAfter(okAt(j), countAfter(j))) bad.push(`${id} at ${j} and ${i}`);
    last.set(id, i);
  });
  return bad;
}

describe("mastery scheduler", () => {
  it("masters every question with exactly five correct answers when always right", () => {
    const { shown, counts } = simulate(30, () => true);
    const own = shown.filter((id) => id.startsWith("q"));
    expect(own.length).toBe(30 * TARGET);
    for (let i = 0; i < 30; i++) expect(counts.get(`q${i}`)).toBe(TARGET);
  });

  it("never shows a question again before its spacing is met", () => {
    for (const n of [1, 2, 3, 7, 25]) {
      const results: boolean[] = [];
      const after: number[] = [];
      const counts = new Map<string, number>();
      const { shown } = simulate(n, (id, k) => {
        const ok = k % 3 !== 0;
        const c = (counts.get(id) ?? 0) + (ok ? 1 : 0);
        counts.set(id, c);
        results.push(ok);
        after.push(c);
        return ok;
      });
      expect(spacingViolations(shown, (i) => results[i], (i) => after[i])).toEqual([]);
    }
  });

  it("mixes in other questions instead of repeating a one-question set", () => {
    const { shown, counts } = simulate(1, () => true);
    expect(counts.get("q0")).toBe(TARGET);
    const at = shown.map((id, i) => (id === "q0" ? i : -1)).filter((i) => i >= 0);
    // 3, 5, 8, then 12 other questions between the five correct answers
    expect(at.slice(1).map((v, k) => v - at[k] - 1)).toEqual([3, 5, 8, 12]);
  });

  it("keeps repeats near: a question returns within a bounded number of steps", () => {
    const { shown } = simulate(60, (_id, k) => k % 4 !== 0);
    const last = new Map<string, number>();
    let worst = 0;
    shown.forEach((id, i) => {
      if (id.startsWith("q") && last.has(id)) worst = Math.max(worst, i - last.get(id)!);
      if (id.startsWith("q")) last.set(id, i);
    });
    expect(worst).toBeLessThanOrEqual(20);
  });

  it("brings a missed question back after a short gap, not immediately", () => {
    const { shown } = simulate(10, (id, k) => !(id === "q0" && k === 1));
    const firstTwo = shown.map((id, i) => (id === "q0" ? i : -1)).filter((i) => i >= 0).slice(0, 2);
    expect(firstTwo[1] - firstTwo[0]).toBeGreaterThanOrEqual(3);
    expect(firstTwo[1] - firstTwo[0]).toBeLessThanOrEqual(6);
  });

  it("finishes with wrong answers mixed in and counts only correct answers", () => {
    const { counts, e } = simulate(20, (_id, k) => k % 2 === 0);
    for (let i = 0; i < 20; i++) expect(counts.get(`q${i}`)).toBe(TARGET);
    expect(remainingInSet(e)).toBe(0);
  });

  it("holds spacing across sessions: a new session does not reopen a question just answered", () => {
    const h = history();
    const set = ids(4);
    const hooks: Hooks = { need: h.need, wait: h.wait, extra: () => ids(50, "x") };
    const first = createEngine(set, hooks);
    const a = nextQuestion(first, hooks)!;
    h.answer(first, a, true);
    // leave and start the same set again, many times over
    for (let k = 0; k < 20; k++) {
      const again = createEngine(set, hooks);
      expect(nextQuestion(again, hooks)).not.toBe(a);
    }
    expect(h.wait(a)).toBe(gapAfter(true, 1));
  });

  it("opens on the clicked question, which then waits its turn after it is answered", () => {
    for (let trial = 0; trial < 100; trial++) {
      const h = history();
      const set = ids(9);
      const hooks: Hooks = { need: h.need, wait: h.wait, extra: () => ids(50, "x") };
      const target = set[trial % set.length];
      const e = createEngine(set, hooks);
      expect(startWith(e, target, hooks)).toBe(target);
      expect(e.active[0].id).toBe(target);
      h.answer(e, target, true);
      for (let k = 0; k < gapAfter(true, 1); k++) {
        const id = nextQuestion(e, hooks)!;
        expect(id).not.toBe(target);
        h.answer(e, id, true);
      }
    }
  });

  it("clicking a question tried too recently leaves it waiting, not due", () => {
    const h = history();
    const set = ids(5);
    const hooks: Hooks = { need: h.need, wait: h.wait, extra: () => ids(50, "x") };
    const e1 = createEngine(set, hooks);
    h.answer(e1, nextQuestion(e1, hooks)!, true);
    // click q0 again from the bank: a new session that starts on it
    const e2 = createEngine(set, hooks);
    startWith(e2, "q0", hooks);
    expect(e2.active[0].due).toBeGreaterThan(e2.step);
    expect(nextQuestion(e2, hooks)).not.toBe("q0");
  });

  it("does not put a mastered question back into rotation when it is clicked", () => {
    const set = ["a", "b", "c"];
    const done = new Set(["b"]);
    const need = (id: string) => (done.has(id) ? 0 : TARGET);
    const e = createEngine(set, need);
    expect(e.pool).not.toContain("b");
    expect(startWith(e, "b", need)).toBe("b");
    expect(e.active.map((s) => s.id)).not.toContain("b");
  });

  it("opens a fresh session on the first question in its order", () => {
    for (let trial = 0; trial < 50; trial++) {
      const need = () => TARGET;
      expect(nextQuestion(createEngine(ids(9), need), need)).toBe("q0");
    }
  });

  it("reports waiting, not complete, when everything left is spacing out and nothing can be mixed in", () => {
    const h = history();
    const hooks: Hooks = { need: h.need, wait: h.wait };
    const e = createEngine(["q0"], hooks);
    h.answer(e, nextQuestion(e, hooks)!, true);
    expect(nextQuestion(e, hooks)).toBeNull();
    expect(remainingInSet(e)).toBe(1);
  });
});
