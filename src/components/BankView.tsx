"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { IconBookmark, IconCheck, IconX } from "./icons";
import { byId, label, sections, type SectionKey } from "@/lib/bank";
import { shade, TARGET } from "@/lib/engine";
import { scopeHref } from "@/lib/scope";
import { useHydrated, useStore, type State } from "@/lib/store";

function level(state: State, id: string) {
  return Math.min(state.q[id]?.c ?? 0, TARGET);
}

export function BankView() {
  const state = useStore();
  const ready = useHydrated();
  const [sec, setSec] = useState<SectionKey>("math");
  const section = sections.find((s) => s.key === sec)!;
  const st = useMemo(() => (ready ? state : ({ q: {} } as State)), [ready, state]);

  const counts = useMemo(() => {
    let mastered = 0;
    let started = 0;
    let missed = 0;
    let marked = 0;
    let unchecked = 0;
    for (const [id, p] of Object.entries(st.q)) {
      if (!byId.has(id)) continue;
      if (p.c >= TARGET) {
        mastered++;
        if (!p.h) unchecked++;
      } else if (p.n > 0) started++;
      if (p.w > 0) missed++;
      if (p.bm) marked++;
    }
    return { mastered, started, missed, marked, unchecked };
  }, [st]);

  return (
    <div className="bank">
      <header className="bank-head">
        <div>
          <h1 className="title">Question bank</h1>
          <p className="subtitle">
            {counts.mastered} of 481 mastered{counts.started ? `, ${counts.started} still to get right` : ""}. A question is mastered once you get it right on the first try, and its tile turns solid white. The corner shows how your last try went.
          </p>
        </div>
        <div className="seg" role="group" aria-label="Section">
          <button aria-pressed={sec === "math"} onClick={() => setSec("math")}>
            Math
          </button>
          <button aria-pressed={sec === "rw"} onClick={() => setSec("rw")}>
            Reading and Writing
          </button>
        </div>
      </header>

      <div className="bank-grid">
        <aside className="bank-rail">
          <Link href={scopeHref({ kind: "bookmarked" })} className="rail-item">
            <IconBookmark size={17} /> Bookmarked <span className="tnum muted">{counts.marked}</span>
          </Link>
          <Link href={scopeHref({ kind: "missed" })} className="rail-item">
            <IconX size={17} /> Missed <span className="tnum muted">{counts.missed}</span>
          </Link>
          {counts.unchecked ? (
            <Link href={scopeHref({ kind: "harden" })} className="rail-item" title="One more pass over mastered questions before the test; a miss takes the mastery away until you get it right again">
              <IconCheck size={17} /> Final check <span className="tnum muted">{counts.unchecked}</span>
            </Link>
          ) : null}
          <div className="rail-label">
            Topics <span>answered right</span>
          </div>
          {section.categories.map((c) => {
            const ids = c.subs.flatMap((s) => s.qs);
            const m = ids.filter((id) => level(st, id) >= TARGET).length;
            // questions gotten right so far: the ones whose tile shows a green check (or that are on their way to 5)
            const right = ids.filter((id) => {
              const p = st.q[id];
              return !!p && (p.c > 0 || (p.n > 0 && !p.lw));
            }).length;
            // every correct answer counts here, toward 5 per question
            const reps = ids.reduce((n, id) => n + level(st, id), 0);
            const of = ids.length * TARGET;
            return (
              <a
                key={c.name}
                href={`#${slug(sec, c.name)}`}
                className="rail-item rail-topic"
                title={`${right} of ${ids.length} answered right, ${m} mastered. The bar shows how much of the topic is mastered.`}
              >
                <span className="grow">
                  {c.name}
                  <span className="rail-bar" aria-hidden>
                    <span style={{ width: `${(reps / of) * 100}%` }} />
                  </span>
                </span>
                <span className="tnum muted">
                  {right}/{ids.length}
                </span>
              </a>
            );
          })}
          <Link href={scopeHref({ kind: "section", value: sec })} className="btn btn-sm" style={{ marginTop: 16 }}>
            Practice all {sec === "math" ? "Math" : "Reading and Writing"}
          </Link>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 14 }}>
            Press Ctrl+Shift+F to jump to a question by number.
          </p>
        </aside>

        <div className="bank-main">
          {section.categories.map((c) => (
            <section key={c.name} id={slug(sec, c.name)} className="cat">
              <div className="cat-head">
                <h2 className="h3">{c.name}</h2>
                <Link className="link" href={scopeHref({ kind: "category", value: `${sec}:${c.name}` })}>
                  Practice this topic
                </Link>
              </div>
              {c.subs.map((s) => (
                <div key={s.key} className="sub-row">
                  <span className="sub-name">{s.name}</span>
                  {/* the big tile is the pattern's first question */}
                  <QTile id={s.qs[0]} subKey={s.key} st={st} big />
                  {s.qs.length > 1 ? (
                    <div className="sub-tiles">
                      {s.qs.slice(1).map((id) => (
                        <QTile key={id} id={id} subKey={s.key} st={st} />
                      ))}
                    </div>
                  ) : (
                    <div />
                  )}
                </div>
              ))}
            </section>
          ))}
          <div className="legend" style={{ marginTop: 28 }}>
            <span>
              <i style={{ background: "var(--m0)" }} />
              Not mastered
            </span>
            <span>
              <i style={{ background: "var(--m5)" }} />
              Mastered
            </span>
            <span>
              <i style={{ background: "var(--good)", borderColor: "var(--good)", borderRadius: 99 }} />
              Last try right
            </span>
            <span>
              <i style={{ background: "var(--bad)", borderColor: "var(--bad)", borderRadius: 99 }} />
              Missed last time
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function QTile({ id, subKey, st, big }: { id: string; subKey: string; st: State; big?: boolean }) {
  const q = byId.get(id)!;
  const p = st.q[id];
  const m = level(st, id);
  const name = label(q);
  return (
    <Link
      href={scopeHref({ kind: "sub", value: subKey, start: id })}
      className={big ? "tile big" : "tile"}
      data-m={shade(m)}
      title={`${name}: ${q.pattern}${p ? `. ${m >= TARGET ? "Mastered" : "Not mastered yet"}${p.w ? `, missed ${p.w}` : ""}` : ""}`}
    >
      {name}
      {/* how the last try went: a green check or a red X */}
      {p?.lw ? (
        <span className="badge miss">
          <IconX size={11} strokeWidth={3} />
        </span>
      ) : p && p.n > 0 ? (
        <span className="badge ok">
          <IconCheck size={11} strokeWidth={3} />
        </span>
      ) : null}
    </Link>
  );
}

function slug(sec: string, name: string) {
  return `${sec}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}
