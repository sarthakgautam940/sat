import { describe, expect, it } from "vitest";
import { applyAttempt, replayLog } from "./progress";
import { cleanCode, formatCode, mergeStates, newCode, sameState, validCode } from "./sync";
import { DEFAULT_SETTINGS, type LogRow, type QS, type State } from "./store";

/** A device: answers go through the same rule the app uses, and into the log. */
function device(gen = "", genAt = 0): State {
  return { v: 1, q: {}, log: [], settings: { ...DEFAULT_SETTINGS }, session: null, at: 0, gen, genAt };
}
function answer(s: State, id: string, ok: boolean, at: number, mode = "learn") {
  s.q[id] = applyAttempt(s.q[id] ?? { c: 0, n: 0, w: 0, t: 0 }, ok, mode, at);
  s.log.push([at, id, ok ? 1 : 0, 1000, ok ? "A" : "B", mode] as LogRow);
  s.at = at;
}
function bookmark(s: State, id: string, on: boolean, at: number) {
  const q: QS = { ...(s.q[id] ?? { c: 0, n: 0, w: 0, t: 0 }) };
  if (on) q.bm = 1;
  else delete q.bm;
  q.bt = at;
  s.q[id] = q;
  s.at = at;
}

describe("sync", () => {
  it("rebuilds exactly the same progress from the answer log", () => {
    const s = device();
    let t = 1000;
    const ids = ["a", "b", "c"];
    for (let i = 0; i < 60; i++) answer(s, ids[i % 3], i % 4 !== 0, (t += 1000));
    // final check: a miss drops a mastered question to 3
    answer(s, "a", false, (t += 1000), "harden");
    answer(s, "b", true, (t += 1000), "harden");
    expect(replayLog(s.log)).toEqual(s.q);
  });

  it("combines answers from two devices instead of overwriting", () => {
    const laptop = device();
    const phone = device();
    answer(laptop, "a", true, 1000);
    answer(laptop, "b", false, 2000);
    answer(phone, "a", true, 1500);
    answer(phone, "c", true, 2500);
    const merged = mergeStates(laptop, phone);
    expect(merged.log.map((r) => r[0])).toEqual([1000, 1500, 2000, 2500]);
    expect(merged.q.a.c).toBe(2);
    expect(merged.q.b.w).toBe(1);
    expect(merged.q.c.c).toBe(1);
    // and the other direction gives the same progress
    expect(mergeStates(phone, laptop).q).toEqual(merged.q);
  });

  it("is a no-op when nothing changed, so it does not write", () => {
    const s = device();
    answer(s, "a", true, 1000);
    expect(sameState(mergeStates(s, structuredClone(s)), s)).toBe(true);
    const twice = mergeStates(mergeStates(s, s), s);
    expect(twice.log.length).toBe(1);
  });

  it("keeps the latest bookmark change", () => {
    const a = device();
    const b = device();
    bookmark(a, "x", true, 1000);
    bookmark(b, "x", true, 1000);
    bookmark(b, "x", false, 2000);
    expect(mergeStates(a, b).q.x.bm).toBeUndefined();
    bookmark(a, "x", true, 3000);
    expect(mergeStates(a, b).q.x.bm).toBe(1);
  });

  it("takes settings and the saved session from the device that changed last", () => {
    const a = device();
    const b = device();
    a.settings.testDate = "2026-12-06";
    a.at = 1000;
    b.settings.hideTimer = true;
    b.at = 2000;
    const m = mergeStates(a, b);
    expect(m.settings.hideTimer).toBe(true);
    expect(m.settings.testDate).toBe(DEFAULT_SETTINGS.testDate);
  });

  it("an erase on one device wins over older progress elsewhere instead of merging it back", () => {
    const old = device();
    answer(old, "a", true, 1000);
    const erased = device("new1", 5000);
    erased.at = 5000;
    expect(mergeStates(old, erased).log).toEqual([]);
    expect(mergeStates(erased, old).log).toEqual([]);
    // but answers made after the erase on the erasing device are kept
    answer(erased, "b", true, 6000);
    expect(mergeStates(old, erased).q.b.c).toBe(1);
  });

  it("connecting a device with a code keeps its answers too", () => {
    const server = device("g1", 5000);
    answer(server, "a", true, 6000);
    const newPhone = device();
    answer(newPhone, "b", true, 3000);
    const m = mergeStates(newPhone, server, true);
    expect(Object.keys(m.q).sort()).toEqual(["a", "b"]);
    expect(m.gen).toBe("g1");
  });

  it("makes codes that are easy to type back in", () => {
    const code = newCode();
    expect(validCode(code)).toBe(true);
    expect(cleanCode(formatCode(code).toUpperCase())).toBe(code);
    expect(cleanCode(" abcd efgh-jkmn pqrs tuvw ")).toBe("abcdefghjkmnpqrstuvw");
    expect(validCode("short")).toBe(false);
  });
});
