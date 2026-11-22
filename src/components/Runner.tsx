"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import refSheet from "@/generated/ref.json";
import { Blocks } from "./Content";
import { DesmosPanel } from "./Desmos";
import { IconArrowLeft, IconArrowRight, IconBookmark, IconBulb, IconCalc, IconCheck, IconEye, IconPause, IconPlay, IconSheet, IconStrike, IconX } from "./icons";
import { byId, label, subByKey, subKeyOf, teach, type Teach } from "@/lib/bank";
import { checkGridIn, cleanGridInput } from "@/lib/answer";
import { createEngine, gapAfter, nextQuestion, recordAnswer, remainingInSet, shade, startWith, TARGET, type Engine, type Hooks } from "@/lib/engine";
import { loadQuestion, type QData } from "@/lib/data";
import { needFor, readiness, recordAttempt, setMark, toggleBookmark, type Mode } from "@/lib/progress";
import { fillersFor, modeOf, poolFor, scopeFromParams, scopeHref } from "@/lib/scope";
import { DEFAULT_SETTINGS, getState, qs, update, useHydrated, useStore, type Scope } from "@/lib/store";
import { ago, clock, minutes } from "@/lib/dates";

/** The calculator can take from a quarter of the window up to 70 percent of it. */
const CALC_MIN = 0.25;
const CALC_MAX = 0.7;
function clampCalc(f: number) {
  return Math.min(CALC_MAX, Math.max(CALC_MIN, Number.isFinite(f) ? f : DEFAULT_SETTINGS.calcWidth));
}

type Phase = "loading" | "answer" | "feedback" | "done" | "empty" | "waiting";
/** When the feedback shows a past try (a question opened before it can count again). */
type Past = { ago: string; wait: number; msLeft: number };
/** A recent miss reopened for more tries: its log key, and whether its answer was revealed. */
type PastMiss = Past & { key: string; revealed: boolean };
/**
 * How a question's showing ended. first: the first try, which is the one that counts.
 * retry: solved on a later try (after a miss, or on a question opened before it can count
 * again), which never counts. reveal: the solution was revealed. practice: solved again in a
 * clean round after Solve again, which changes nothing.
 */
type Result = {
  ok: boolean;
  response: string;
  before: number;
  after: number;
  mastered: boolean;
  ms: number;
  past?: Past;
  how: "first" | "retry" | "reveal" | "practice";
  /** for a practice solve: why it changes nothing (the first try was right, revealed, or already fixed) */
  basis?: "right" | "revealed" | "fixed";
  /** the log key of the first try this result is about (for marking it) */
  key?: string;
  /** a retry that turned the earlier miss green in stats */
  fixed?: boolean;
};
type Tally = { answered: number; correct: number; mastered: number };

function sameScope(a: Scope, b: Scope) {
  return a.kind === b.kind && (a.value ?? "") === (b.value ?? "");
}

type Init = {
  engine: Engine;
  mode: Mode;
  scopeIds: string[];
  first: string | null;
  /** the first question is shown as its last try, not as a new one */
  firstPast: boolean;
  /** the first question was mixed in from outside the set */
  firstMixed: boolean;
  tally: Tally;
  need: (id: string) => number;
  hooks: () => Hooks;
  /** review questions answered right this session (they're done) */
  reviewedRight: Set<string>;
};

/** Build or resume the session from saved progress (runs once, on the client). */
function initSession(scope: Scope): Init {
  const s = getState();
  const mode = modeOf(scope);
  const scopeIds = poolFor(scope, s);
  // Bookmarked and Missed are review lists: their questions come up even when mastered, until
  // answered right once in this session (a review never changes mastery).
  const review = scope.kind === "bookmarked" || scope.kind === "missed";
  const inScope = new Set(scopeIds);
  const reviewedRight = new Set<string>();
  const need = (id: string) => {
    const left = needFor(getState(), id, mode);
    if (left > 0) return left;
    return review && inScope.has(id) && !reviewedRight.has(id) ? 1 : 0;
  };
  // Spacing comes from the saved answer log, so it holds across sessions and tile clicks.
  // While the whole set is waiting, questions from nearby topics are mixed in (learning only).
  const extra = mode === "learn" ? fillersFor(scope, s) : [];
  const hooks = (): Hooks => {
    const r = readiness(getState(), Date.now());
    return { need, wait: r.wait, extra: () => extra };
  };
  const saved = s.session;
  let engine: Engine;
  let tally: Tally = { answered: 0, correct: 0, mastered: 0 };
  const resumed = !!saved && sameScope(saved.scope, scope) && !scope.start && remainingInSet(saved.engine) > 0;
  if (saved && resumed) {
    engine = saved.engine;
    tally = { answered: saved.answered, correct: saved.correct, mastered: 0 };
  } else {
    engine = createEngine(scopeIds, need);
  }
  // A review list (Bookmarked, Missed) opens on its first question, like a clicked tile.
  const opener = scope.start ?? (review && !resumed ? scopeIds.find((id) => need(id) > 0) : undefined);
  // A clicked question always opens first. If it can count now (never tried, or spaced out
  // enough since its last try) it is a new try; otherwise its last try is shown, with the
  // answer and explanation, and nothing is recorded.
  let first: string | null;
  let firstPast = false;
  if (opener && byId.has(opener)) {
    const h = hooks();
    first = startWith(engine, opener, h);
    const r = readiness(s, Date.now());
    firstPast = !!r.last(first) && (need(first) <= 0 || r.wait(first) > 0);
  } else {
    first = nextQuestion(engine, hooks());
  }
  const firstMixed = !!engine.active.find((slot) => slot.id === first)?.filler;
  return { engine, mode, scopeIds, first, firstPast, firstMixed, tally, need, hooks, reviewedRight };
}

export function Runner() {
  const params = useSearchParams();
  const key = params.toString();
  const scope = useMemo(() => scopeFromParams(new URLSearchParams(key)), [key]);
  const hydrated = useHydrated();
  if (!hydrated) return null;
  return <Session key={key} scope={scope} />;
}

function Session({ scope }: { scope: Scope }) {
  const state = useStore();
  const [init] = useState(() => initSession(scope));
  const { engine, mode, scopeIds, need, hooks, reviewedRight } = init;

  const [current, setCurrent] = useState<string | null>(init.first);
  const [past, setPast] = useState(init.firstPast);
  const [mixed, setMixed] = useState(init.firstMixed);
  const [turn, setTurn] = useState(0);
  const [data, setData] = useState<QData | null>(null);
  const [phase, setPhase] = useState<Phase>(init.first ? "loading" : remainingInSet(engine) > 0 ? "waiting" : "empty");
  const [result, setResult] = useState<Result | null>(null);
  // wrong answers tried in this showing; the question stays open until it's solved or revealed
  const [tries, setTries] = useState<string[]>([]);
  // set when a question missed recently is reopened for more tries (they don't count yet)
  const [pastMiss, setPastMiss] = useState<PastMiss | null>(null);
  const [firstMs, setFirstMs] = useState(0);
  // the recorded first try of this showing (its log key and whether it was right)
  const [firstKey, setFirstKey] = useState<string | null>(null);
  const [firstOk, setFirstOk] = useState<boolean | null>(null);
  const [struck, setStruck] = useState<Set<string>>(new Set());
  const [grid, setGrid] = useState("");
  const [calc, setCalc] = useState(false);
  // calculator width while dragging (null when not dragging); the saved width otherwise
  const [dragFrac, setDragFrac] = useState<number | null>(null);
  const calcFrac = dragFrac ?? clampCalc(state.settings.calcWidth ?? DEFAULT_SETTINGS.calcWidth);
  const saveCalcWidth = (f: number) => update((s) => void (s.settings.calcWidth = clampCalc(f)));
  const startCalcDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    let last = calcFrac;
    const move = (ev: PointerEvent) => {
      const w = window.innerWidth;
      // leave the question at least 360px on narrower screens
      last = Math.min(clampCalc((w - ev.clientX) / w), Math.max(CALC_MIN, (w - 360) / w));
      setDragFrac(last);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.classList.remove("resizing");
      saveCalcWidth(last);
      setDragFrac(null);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  const [ref, setRef] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const [tally, setTally] = useState<Tally>(init.tally);
  // clock: when the question appeared, time spent paused, and when the current pause began
  const [clockState, setClockState] = useState({ start: 0, pausedMs: 0, pauseAt: 0 });
  const [tick, setTick] = useState(0);
  const paused = clockState.pauseAt > 0;

  // Load the current question.
  useEffect(() => {
    if (!current) return;
    let alive = true;
    loadQuestion(current).then((q) => {
      if (!alive) return;
      setData(q);
      if (past) {
        // opened before it can count again: show the last try instead of a new one
        const s = getState();
        const r = readiness(s, Date.now());
        const last = r.last(current);
        if (last) {
          const c = qs(s, current).c;
          const info: Past = { ago: ago(Date.now() - last.at), wait: r.wait(current), msLeft: r.msLeft(current) };
          const key = `${last.at}|${current}`;
          const mark = s.marks?.[key];
          setFirstKey(key);
          setFirstOk(last.ok);
          const fixed = !last.ok && !!mark?.fixed && !mark.revealed;
          if (last.ok || fixed) {
            // right, or a miss already fixed: show it solved (an earlier wrong pick stays red)
            if (fixed) setTries([last.response]);
            const right = last.ok ? last.response : q.type === "mc" ? (q.answer as string) : (q.answer as string[])[0];
            setResult({ ok: true, response: right, before: c, after: c, mastered: false, ms: last.ms, past: info, how: last.ok ? "first" : "retry", key, fixed });
            setShowWhy(false);
            setPhase("feedback");
            window.scrollTo({ top: 0 });
            return;
          }
          // a recent miss: open it for more tries with that miss marked, answer still hidden
          setTries([last.response]);
          if (q.type !== "mc") setGrid(last.response);
          setPastMiss({ ...info, key, revealed: !!mark?.revealed });
        }
      }
      setPhase("answer");
      const t = performance.now();
      setClockState({ start: t, pausedMs: 0, pauseAt: 0 });
      setTick(t);
      window.scrollTo({ top: 0 });
      // warm the cache for the rest of the working set
      engine.active.forEach((slot) => void loadQuestion(slot.id).catch(() => {}));
    });
    return () => {
      alive = false;
    };
  }, [current, turn, engine, past]);

  // timer
  useEffect(() => {
    if (phase !== "answer" || paused) return;
    const t = setInterval(() => setTick(performance.now()), 500);
    return () => clearInterval(t);
  }, [phase, paused]);
  const elapsed = phase === "answer" && !paused ? Math.max(0, tick - clockState.start - clockState.pausedMs) : 0;

  const togglePause = () => {
    if (phase !== "answer") return;
    const t = performance.now();
    setClockState((c) => (c.pauseAt ? { ...c, pausedMs: c.pausedMs + (t - c.pauseAt), pauseAt: 0 } : { ...c, pauseAt: t }));
  };

  const answer = useCallback(
    (response: string) => {
      if (phase !== "answer" || !current || !data || paused) return;
      if (data.type === "mc" && tries.includes(response)) return;
      const ok = data.type === "mc" ? response === data.answer : checkGridIn(response, data.answer as string[]);
      const ms = performance.now() - clockState.start - clockState.pausedMs;
      // Only the first try of a showing counts (and is recorded). A miss stays a miss even if
      // a later try is right, so picking through the choices can never earn mastery.
      if (!past && !firstKey) {
        const before = qs(getState(), current).c;
        const key = recordAttempt(current, ok, ms, response, mode);
        setFirstKey(key);
        setFirstOk(ok);
        const after = qs(getState(), current).c;
        if (ok) reviewedRight.add(current);
        recordAnswer(engine, current, ok, after, need(current));
        const mastered = before < TARGET && after >= TARGET;
        const next: Tally = { answered: tally.answered + 1, correct: tally.correct + (ok ? 1 : 0), mastered: tally.mastered + (mastered ? 1 : 0) };
        setTally(next);
        update((s) => {
          s.session = { scope, engine, startedAt: s.session && sameScope(s.session.scope, scope) ? s.session.startedAt : Date.now(), answered: next.answered, correct: next.correct };
        });
        setFirstMs(ms);
        if (ok) {
          setResult({ ok, response, before, after, mastered, ms, how: "first", key });
          setShowWhy(false);
          setPhase("feedback");
        } else {
          setTries([response]);
        }
        return;
      }
      // a later try: nothing is recorded; wrong ones are marked, the answer stays hidden
      if (!ok) {
        setTries((t) => (t.includes(response) ? t : [...t, response]));
        return;
      }
      // Fixed without revealing: the miss turns green and counts as right in stats (mastery
      // still only grows on a clean first try). If the first try was right, or the miss was
      // revealed or already fixed, this is practice and changes nothing.
      const key = firstKey ?? undefined;
      const mark = key ? getState().marks?.[key] : undefined;
      const basis = firstOk === true ? "right" : mark?.revealed ? "revealed" : mark?.fixed ? "fixed" : undefined;
      const fixed = !!key && !basis;
      if (key && fixed) setMark(key, { fixed: 1 });
      if (fixed && !pastMiss) {
        setTally((t) => ({ ...t, correct: t.correct + 1 }));
        update((s) => {
          if (s.session && sameScope(s.session.scope, scope)) s.session.correct += 1;
        });
      }
      const c = qs(getState(), current).c;
      setResult({ ok: true, response, before: c, after: c, mastered: false, ms: firstMs || ms, past: pastMiss ?? undefined, how: basis ? "practice" : "retry", basis, key, fixed });
      setShowWhy(false);
      setPhase("feedback");
    },
    [phase, past, tries, firstMs, firstKey, firstOk, pastMiss, current, data, paused, clockState, mode, engine, need, tally, scope, reviewedRight],
  );

  /** Show the answer and explanation. Only ever on request. */
  const reveal = () => {
    if (phase !== "answer" || !current || !data || (!tries.length && !firstKey)) return;
    const key = firstKey ?? undefined;
    const mark = key ? getState().marks?.[key] : undefined;
    const basis = firstOk === true ? "right" : mark?.revealed ? "revealed" : mark?.fixed ? "fixed" : undefined;
    // revealing keeps a miss a miss (a miss already fixed stays fixed)
    if (key && !basis) setMark(key, { revealed: 1 });
    const c = qs(getState(), current).c;
    setResult({ ok: false, response: tries[tries.length - 1] ?? "", before: c, after: c, mastered: false, ms: firstMs, past: pastMiss ?? undefined, how: "reveal", basis, key });
    setShowWhy(true);
    setPhase("feedback");
  };

  /** Wipe the screen clean to solve the question again. Nothing about the record changes. */
  const solveAgain = () => {
    if (!current || !data) return;
    setResult(null);
    setTries([]);
    setStruck(new Set());
    setGrid("");
    setShowWhy(false);
    const t = performance.now();
    setClockState({ start: t, pausedMs: 0, pauseAt: 0 });
    setTick(t);
    setPhase("answer");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const advance = useCallback(() => {
    // from the result, or straight on once a first try is in (without revealing)
    if (phase !== "feedback" && !(phase === "answer" && (tries.length > 0 || firstKey))) return;
    // in a review list, a mastered question seen again (or solved) is reviewed: don't bring it back
    if (current && (past || result?.ok) && (getState().q[current]?.c ?? 0) >= TARGET) reviewedRight.add(current);
    const next = nextQuestion(engine, hooks());
    setResult(null);
    setTries([]);
    setPastMiss(null);
    setFirstMs(0);
    setFirstKey(null);
    setFirstOk(null);
    setStruck(new Set());
    setGrid("");
    setShowWhy(false);
    setPast(false);
    if (!next) {
      setCurrent(null);
      setData(null);
      // either the set is complete, or everything left is waiting for its spacing
      const waiting = remainingInSet(engine) > 0;
      setPhase(waiting ? "waiting" : "done");
      if (!waiting) {
        update((s) => {
          if (s.session && sameScope(s.session.scope, scope)) s.session = null;
        });
      }
      return;
    }
    setMixed(!!engine.active.find((slot) => slot.id === next)?.filler);
    setPhase("loading");
    setCurrent(next);
    setTurn((t) => t + 1);
  }, [phase, tries, firstKey, current, past, result, reviewedRight, engine, hooks, scope]);

  // After answering, only the Next question button (or a deliberate Enter) moves on. Clicks,
  // Space, and arrow keys never do. Enter is ignored while held, right after answering (so the
  // Enter that submitted a typed answer can't skip the feedback), and inside the calculator,
  // the reference sheet, or a focused control, which handle Enter themselves.
  useEffect(() => {
    if (phase !== "feedback") return;
    const armedAt = performance.now();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (performance.now() - armedAt < 400) return;
      const el = e.target as HTMLElement;
      if (el.closest("a, button, input, textarea, select, [contenteditable], .calcpanel, .refsheet, .overlay")) return;
      e.preventDefault();
      advance();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, advance]);

  // Keyboard: A-D or 1-4 to answer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (phase === "answer" && data?.type === "mc") {
        const k = e.key.toUpperCase();
        const idx = "ABCD".indexOf(k) >= 0 ? "ABCD".indexOf(k) : "1234".indexOf(e.key);
        if (idx >= 0 && data.choices[idx]) {
          e.preventDefault();
          answer(data.choices[idx].l);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, data, answer]);

  const meta = current ? byId.get(current) : undefined;
  const subKey = meta ? subKeyOf(meta) : "";
  const sub = subKey ? subByKey.get(subKey) : undefined;
  const note = subKey ? teach[subKey] : undefined;
  const p = current ? qs(state, current) : null;
  const scopeDone = scopeIds.filter((id) => (state.q[id]?.c ?? 0) >= TARGET).length;
  // a clean round on a question whose record can't change any more
  const firstMark = firstKey ? state.marks?.[firstKey] : undefined;
  const practiceRound = firstOk === true || !!firstMark?.fixed || !!firstMark?.revealed;

  return (
    <div className={`runner${calc || ref ? " split" : ""}`}>
      <header className="rhead">
        <div className="rhead-l">
          <Link href="/" className="icon-btn" aria-label="Back to the question bank">
            <IconArrowLeft />
          </Link>
          <div className="rscope">
            <strong>{scope.label}</strong>
            {scopeIds.length ? (
              <span className="muted tnum">
                {scopeDone} of {scopeIds.length} mastered
              </span>
            ) : null}
          </div>
        </div>
        <div className="rhead-c">
          {!state.settings.hideTimer ? (
            <>
              <button className="icon-btn" onClick={togglePause} aria-label={paused ? "Resume" : "Pause"} disabled={phase !== "answer"}>
                {paused ? <IconPlay /> : <IconPause />}
              </button>
              <span className="clock tnum">{clock(phase === "feedback" && result ? result.ms : elapsed)}</span>
            </>
          ) : null}
          <button
            className="icon-btn"
            onClick={() => update((s) => void (s.settings.hideTimer = !s.settings.hideTimer))}
            aria-label={state.settings.hideTimer ? "Show timer" : "Hide timer"}
            title={state.settings.hideTimer ? "Show timer" : "Hide timer"}
          >
            <IconEye off={!state.settings.hideTimer} />
          </button>
        </div>
        <div className="rhead-r">
          <button className="icon-btn" aria-pressed={ref} onClick={() => setRef((v) => !v)} aria-label="Reference sheet" title="Reference sheet">
            <IconSheet />
          </button>
          <button className="icon-btn" aria-pressed={calc} onClick={() => setCalc((v) => !v)} aria-label="Desmos calculator" title="Desmos calculator">
            <IconCalc />
          </button>
        </div>
      </header>

      <div className="rbody">
        <main className="qpane">
          {phase === "empty" ? (
            <EmptySet scope={scope} />
          ) : phase === "waiting" ? (
            <Waiting scope={scope} />
          ) : phase === "done" ? (
            <Done tally={tally} />
          ) : (
            <div className="qcol">
              {meta && sub ? (
                <div className="qmeta">
                  <span className="tile" data-m={shade(p?.c ?? 0)}>
                    {label(meta)}
                  </span>
                  <div className="grow">
                    <div className="qsub">
                      {sub.n}. {sub.name}
                    </div>
                    <div className="muted qcat">
                      {meta.section === "math" ? "Math" : "Reading and Writing"}, {meta.category}
                    </div>
                    {mixed ? <div className="muted qcat">Mixed in while the questions in {scope.label} wait their turn</div> : null}
                  </div>
                  {TARGET > 1 ? <Pips c={p?.c ?? 0} pop={result?.ok && result.how === "first" && !result.past ? result.after : -1} /> : null}
                  <button className="icon-btn" aria-pressed={!!p?.bm} onClick={() => current && toggleBookmark(current)} aria-label={p?.bm ? "Remove bookmark" : "Bookmark"} title="Bookmark">
                    <IconBookmark filled={!!p?.bm} />
                  </button>
                </div>
              ) : null}

              {data && phase !== "loading" ? (
                <div className={`question${paused ? " paused" : ""}`} data-qid={current ?? undefined}>
                  {paused ? (
                    <button className="paused-cover" onClick={togglePause}>
                      <IconPlay size={28} />
                      Paused. Click to resume.
                    </button>
                  ) : null}
                  <Blocks blocks={data.stem} />
                  {data.type === "mc" ? (
                    <div className="choices">
                      {data.choices.map((ch) => {
                        // the right answer only turns green once it's solved or revealed
                        let st = "idle";
                        if (result) {
                          if (ch.l === data.answer) st = "correct";
                          else if (tries.includes(ch.l)) st = "wrong";
                          else st = "dim";
                        } else if (tries.includes(ch.l)) st = "wrong";
                        else if (struck.has(ch.l)) st = "struck";
                        const open = phase === "answer" && !tries.includes(ch.l);
                        return (
                          <div className="choice-row" key={ch.l}>
                            <div
                              role="button"
                              tabIndex={open ? 0 : -1}
                              className="choice"
                              data-state={st}
                              aria-label={`Choice ${ch.l}`}
                              aria-disabled={!open}
                              onClick={(e) => {
                                if (open) {
                                  e.stopPropagation();
                                  answer(ch.l);
                                }
                              }}
                              onKeyDown={(e) => {
                                if (open && (e.key === "Enter" || e.key === " ")) {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  answer(ch.l);
                                }
                              }}
                            >
                              <span className="letter">{st === "correct" ? <IconCheck size={16} /> : st === "wrong" ? <IconX size={16} /> : ch.l}</span>
                              <div className="ccontent">
                                <Blocks blocks={ch.c} />
                              </div>
                            </div>
                            {open ? (
                              <button
                                className="strike"
                                aria-pressed={struck.has(ch.l)}
                                aria-label={struck.has(ch.l) ? `Restore choice ${ch.l}` : `Cross out choice ${ch.l}`}
                                title="Cross out"
                                onClick={() =>
                                  setStruck((prev) => {
                                    const n = new Set(prev);
                                    if (n.has(ch.l)) n.delete(ch.l);
                                    else n.add(ch.l);
                                    return n;
                                  })
                                }
                              >
                                <IconStrike size={18} />
                              </button>
                            ) : (
                              <span className="strike-space" />
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <form
                      className="gridin"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (grid.trim()) answer(grid.trim());
                      }}
                    >
                      <input
                        className={`field${result ? (result.ok ? " ok" : " bad") : tries.length && grid.trim() === tries[tries.length - 1] ? " bad" : ""}`}
                        value={result ? result.response : grid}
                        onChange={(e) => setGrid(cleanGridInput(e.target.value))}
                        placeholder="Your answer"
                        inputMode="decimal"
                        autoComplete="off"
                        disabled={phase !== "answer"}
                        aria-label="Your answer"
                        autoFocus
                      />
                      {phase === "answer" ? (
                        <button className="btn" type="submit" disabled={!grid.trim()}>
                          Check
                        </button>
                      ) : null}
                      <p className="muted gridhelp">Type a whole number, a fraction like 7/2, or a decimal like 3.5. Negative answers start with a minus sign.</p>
                    </form>
                  )}
                </div>
              ) : (
                <div className="loading muted">Loading the question</div>
              )}

              {phase === "answer" && data && (tries.length > 0 || firstKey) ? (
                <>
                  <p className="miss-note" role="status">
                    {tries.length ? <strong>Not quite. </strong> : null}
                    {missNote(pastMiss, data.type === "mc" ? [] : tries, practiceRound, tries.length === 0)}
                    {tries.length ? (
                      <>
                        {" "}
                        <button className="link" onClick={solveAgain}>
                          Clear tries
                        </button>
                      </>
                    ) : null}
                  </p>
                  <div className="nextbar">
                    {tries.length ? <span className="muted nextbar-hint">Try again, or</span> : null}
                    <button className="btn" onClick={reveal}>
                      Reveal solution
                    </button>
                    <button className="btn btn-ghost" onClick={advance}>
                      {remainingInSet(engine) ? "Next question" : "Finish set"}
                      <IconArrowRight size={18} />
                    </button>
                  </div>
                </>
              ) : null}

              {phase === "feedback" && result && data ? (
                <>
                  <Feedback
                    result={result}
                    data={data}
                    note={note}
                    showWhy={showWhy}
                    setShowWhy={setShowWhy}
                    subName={sub?.name ?? ""}
                    studied={!!(result.key && state.marks?.[result.key]?.study)}
                    onStudy={result.how !== "reveal" && result.key ? () => setMark(result.key!, { study: state.marks?.[result.key!]?.study ? 0 : 1 }) : undefined}
                    onSolveAgain={solveAgain}
                  />
                  <div className="nextbar">
                    <span className="muted nextbar-hint">or press Enter</span>
                    <button className="btn" onClick={advance}>
                      {remainingInSet(engine) ? "Next question" : "Finish set"}
                      <IconArrowRight size={18} />
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          )}
        </main>
        <aside className="refsheet" style={{ display: ref ? "block" : "none" }}>
          <div className="panel-head">
            <strong>Reference</strong>
            <button className="icon-btn" onClick={() => setRef(false)} aria-label="Close reference sheet">
              <IconX />
            </button>
          </div>
          <div className="refbody">
            {(refSheet as { label: string; html?: string; text?: string }[]).map((r) => (
              <div key={r.label} className="refrow">
                <div className="muted">{r.label}</div>
                {r.html ? <div dangerouslySetInnerHTML={{ __html: r.html }} /> : <div>{r.text}</div>}
              </div>
            ))}
          </div>
        </aside>
        <aside className="calcpanel" style={{ display: calc ? "flex" : "none", width: `${calcFrac * 100}vw` }}>
          <div
            className="resize-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label="Drag to resize the calculator"
            aria-valuemin={CALC_MIN * 100}
            aria-valuemax={CALC_MAX * 100}
            aria-valuenow={Math.round(calcFrac * 100)}
            tabIndex={0}
            title="Drag to resize. Double-click to reset."
            onPointerDown={startCalcDrag}
            onDoubleClick={() => saveCalcWidth(DEFAULT_SETTINGS.calcWidth)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                e.stopPropagation();
                saveCalcWidth(calcFrac + (e.key === "ArrowLeft" ? 0.03 : -0.03));
              }
            }}
          />
          <div className="panel-head">
            <strong>Calculator</strong>
            <button className="icon-btn" onClick={() => setCalc(false)} aria-label="Close calculator">
              <IconX />
            </button>
          </div>
          <DesmosPanel visible={calc} />
        </aside>
      </div>
    </div>
  );
}

function Pips({ c, pop }: { c: number; pop: number }) {
  return (
    <span className="pips" title={`${Math.min(c, TARGET)} of ${TARGET} correct`} aria-label={`${Math.min(c, TARGET)} of ${TARGET} correct`}>
      {Array.from({ length: TARGET }, (_, i) => (
        <span key={i} className={`${i < c ? "on" : ""}${i + 1 === pop ? " pop" : ""}`} />
      ))}
    </span>
  );
}

function Feedback({
  result,
  data,
  note,
  showWhy,
  setShowWhy,
  subName,
  studied,
  onStudy,
  onSolveAgain,
}: {
  result: Result;
  data: QData;
  note: Teach | undefined;
  showWhy: boolean;
  setShowWhy: (v: boolean) => void;
  subName: string;
  studied: boolean;
  onStudy?: () => void;
  onSolveAgain: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);
  const correctText = data.type === "mc" ? `The answer is ${data.answer}.` : `Accepted answers: ${(data.answer as string[]).join(", ")}.`;
  return (
    <section className="feedback" data-ok={result.how === "reveal" ? "0" : "1"} ref={box}>
      <div className="fb-head">
        <div>
          <div className="fb-title">{result.how === "reveal" ? "Solution" : result.mastered ? "Correct. Mastered." : "Correct."}</div>
          <div className="muted">{resultNote(result, correctText, studied)}</div>
        </div>
        <div className="fb-actions">
          <button className="link" onClick={onSolveAgain} title="Clear the screen and solve it again. It doesn't change your record.">
            Solve again
          </button>
          {!showWhy ? (
            <button className="link" onClick={() => setShowWhy(true)}>
              Show the explanation
            </button>
          ) : null}
          {onStudy ? (
            <button className="link" aria-pressed={studied} onClick={onStudy} title="Counts this as a miss in your stats and puts it in your Missed list">
              {studied ? "Marked for study" : "Mark for study"}
            </button>
          ) : null}
        </div>
      </div>
      {showWhy ? (
        <>
          <div className="fb-block">
            <h3 className="h3">Explanation</h3>
            <Blocks blocks={data.rationale} className="qtext rationale" />
          </div>
          {note ? (
            <div className="fb-block teach">
              <h3 className="h3">
                <IconBulb size={18} /> The pattern: {subName}
              </h3>
              <p>{note.what}</p>
              <ol>
                {note.how.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ol>
              {note.desmos ? (
                <p>
                  <strong>Desmos:</strong> {note.desmos}
                </p>
              ) : null}
              <p>
                <strong>Trap:</strong> {note.trap}
              </p>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** When a question that can't count yet will count again. */
function countsAgain(past: Past): string {
  return past.wait > 0
    ? `Your next try counts after ${past.wait} other ${past.wait === 1 ? "question" : "questions"}, or in ${minutes(past.msLeft)}.`
    : "It is ready for another try.";
}

const MISS_GAP = gapAfter(false, 0);

/** The line under the choices after a miss, while the question is still open. */
function missNote(pastMiss: PastMiss | null, typed: string[], practice: boolean, clean: boolean): string {
  const tried = typed.length > 1 ? ` Tried so far: ${typed.join(", ")}.` : "";
  const keep = "Try again as many times as you like. The answer stays hidden unless you reveal it.";
  if (practice && !pastMiss) return `${clean ? "Clean slate. " : ""}Practice round: nothing here changes your stats or mastery. ${keep}${tried}`;
  if (clean && !pastMiss) return `Clean slate. Your first try still counts as a miss; get it right here without revealing the answer and it turns green. ${keep}`;
  if (pastMiss?.revealed) return `You missed this ${pastMiss.ago} and revealed the answer, so it stays a miss in your stats. ${keep}${tried} ${countsAgain(pastMiss)}`;
  if (pastMiss) return `You missed this ${pastMiss.ago}. ${keep}${tried} Fix it now and that miss turns green and counts as right in your stats. ${countsAgain(pastMiss)}`;
  return `${keep}${tried} Fix it yourself and it turns green and counts as right in your stats; reveal it or move on and it stays a miss.`;
}

/** Where a question stands toward mastery. */
function standing(c: number): string {
  if (c >= TARGET) return "Mastered.";
  return TARGET === 1 ? "Not mastered yet." : `${c} of ${TARGET} toward mastery.`;
}

const STUDY = "Marked for study, so it counts as a miss in your stats and shows in your Missed list.";

/** The line in the result box. */
function resultNote(result: Result, correctText: string, studied: boolean): string {
  const c = Math.min(result.after, TARGET);
  if (result.how === "first") {
    const study = studied ? ` ${STUDY}` : "";
    if (!result.past) return `${standing(c)}${study}`;
    const when = `You answered this ${result.past.ago}.`;
    return c >= TARGET ? `${when} Mastered.${study}` : `${when} ${standing(c)}${study} ${countsAgain(result.past)}`;
  }
  if (result.how === "retry") {
    const stats = studied ? STUDY : result.fixed ? "Fixed, so that miss counts as right in your stats." : "The answer was revealed last time, so that miss still counts.";
    if (result.past) return `${stats} ${countsAgain(result.past)}`;
    return `${stats} Mastery needs a clean first try, so it comes back after ${MISS_GAP} other questions for one.`;
  }
  if (result.how === "practice") {
    const why =
      result.basis === "revealed"
        ? "Solved. The answer was revealed earlier, so that miss still counts in your stats."
        : result.basis === "fixed"
          ? "Solved again. That miss was already fixed, so nothing changes."
          : "Solved again. Practice rounds don't change your stats or mastery.";
    return `${why}${studied ? ` ${STUDY}` : ""}${result.past ? ` ${countsAgain(result.past)}` : ""}`;
  }
  if (result.basis) return `${correctText} This was a practice round, so nothing changes.`;
  return `${correctText} ${result.past ? countsAgain(result.past) : `This one counts as a miss and comes back after ${MISS_GAP} other questions.`}`;
}

function Done({ tally }: { tally: { answered: number; correct: number; mastered: number } }) {
  const pct = tally.answered ? Math.round((tally.correct / tally.answered) * 100) : 0;
  return (
    <div className="done">
      <h1 className="title">Set complete</h1>
      <p className="subtitle">
        {tally.answered ? `${tally.answered} answers, ${tally.correct} correct (${pct}%). ${tally.mastered} ${tally.mastered === 1 ? "question" : "questions"} mastered this session.` : "Every question in this set is mastered."}
      </p>
      <div style={{ display: "flex", gap: 10, marginTop: 24, flexWrap: "wrap" }}>
        <Link className="btn" href="/">
          Question bank
        </Link>
      </div>
    </div>
  );
}

function Waiting({ scope }: { scope: Scope }) {
  return (
    <div className="done">
      <h1 className="title">Nothing here can count yet</h1>
      <p className="subtitle">
        Every question left in {scope.label} was tried too recently. A try only counts toward mastery after a few other questions in between (or about an hour), so these are waiting their turn.
      </p>
      <div style={{ display: "flex", gap: 10, marginTop: 24, flexWrap: "wrap" }}>
        {scope.kind !== "all" && scope.kind !== "harden" ? (
          <Link className="btn" href={scopeHref({ kind: "all" })}>
            Practice all questions
          </Link>
        ) : null}
        <Link className={scope.kind !== "all" && scope.kind !== "harden" ? "btn btn-ghost" : "btn"} href="/">
          Question bank
        </Link>
      </div>
    </div>
  );
}

function EmptySet({ scope }: { scope: Scope }) {
  const msg =
    scope.kind === "missed"
      ? "Nothing missed yet."
      : scope.kind === "bookmarked"
        ? "No bookmarks yet. Use the bookmark button on any question."
        : scope.kind === "harden"
          ? "Nothing to check yet: master some questions first, or every mastered question already passed its final check."
          : "Every question in this set is mastered.";
  return (
    <div className="done">
      <h1 className="title">{scope.label}</h1>
      <p className="subtitle">{msg}</p>
      <div style={{ marginTop: 24 }}>
        <Link className="btn" href="/">
          Question bank
        </Link>
      </div>
    </div>
  );
}
