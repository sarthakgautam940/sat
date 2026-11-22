"use client";

import { useRef, useState } from "react";
import { applySyncedState, DEFAULT_SETTINGS, getState, normalizeState, resetState, update, useHydrated, useStore, type State } from "@/lib/store";
import { formatCode, joinSync, mergeStates, startNewSync, stopSync, syncLink, syncNow, useSyncStatus } from "@/lib/sync";
import { ago } from "@/lib/dates";
import { useNow } from "@/lib/useNow";

export function SettingsView() {
  const state = useStore();
  const ready = useHydrated();
  const file = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState("");
  if (!ready) return <div style={{ minHeight: 400 }} />;
  const s = state.settings;

  const exportData = () => {
    const blob = new Blob([JSON.stringify(state)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sat-bank-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importData = async (f: File) => {
    try {
      const parsed = JSON.parse(await f.text()) as State;
      if (parsed.v !== 1 || typeof parsed.q !== "object" || !Array.isArray(parsed.log)) throw new Error("not a progress file");
      // add the file's answers to what's here; nothing here is overwritten
      const local = getState();
      const merged: State = { ...mergeStates(local, normalizeState(parsed), true), gen: local.gen, genAt: local.genAt, at: Date.now() };
      const added = merged.log.length - local.log.length;
      applySyncedState(merged);
      void syncNow();
      setMsg(added ? `Added ${added} ${added === 1 ? "answer" : "answers"} from the file to your progress.` : "Everything in that file was already here.");
    } catch {
      setMsg("That file isn't a SAT Bank progress file.");
    }
  };

  return (
    <div style={{ maxWidth: 680 }}>
      <h1 className="title">Settings</h1>
      <p className="subtitle">Progress is saved in this browser, and on every device you connect with sync.</p>

      <SyncSection />

      <section className="section">
        <h2 className="h2">Schedule</h2>
        <div className="form-row">
          <label htmlFor="test">Test date</label>
          <input id="test" type="date" className="field" value={s.testDate} onChange={(e) => e.target.value && update((d) => void (d.settings.testDate = e.target.value))} />
        </div>
        <div className="form-row">
          <label htmlFor="timer">Show the timer during practice</label>
          <input id="timer" type="checkbox" className="check" checked={!s.hideTimer} onChange={(e) => update((d) => void (d.settings.hideTimer = !e.target.checked))} />
        </div>
        {s.testDate !== DEFAULT_SETTINGS.testDate ? (
          <button className="link" onClick={() => update((d) => void (d.settings.testDate = DEFAULT_SETTINGS.testDate))}>
            Reset to December 5
          </button>
        ) : null}
      </section>

      <section className="section">
        <h2 className="h2">Backup</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          {Object.keys(state.q).length} questions with progress, {state.log.length.toLocaleString()} answers saved. Importing a file adds its answers to yours; nothing is overwritten.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn" onClick={exportData}>
            Export progress
          </button>
          <button className="btn btn-ghost" onClick={() => file.current?.click()}>
            Import progress
          </button>
          <input ref={file} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && importData(e.target.files[0])} />
        </div>
        {msg ? <p style={{ marginTop: 12 }}>{msg}</p> : null}
      </section>

      <section className="section">
        <h2 className="h2">Start over</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Clears every answer and all mastery in this browser, and on every device connected with sync. Export first if you might want it back.
        </p>
        <button
          className="btn btn-ghost"
          onClick={() => {
            if (window.confirm("Erase all progress? This also erases it on every device connected with sync.")) {
              resetState();
              void syncNow();
              setMsg("Progress erased.");
            }
          }}
        >
          Erase all progress
        </button>
      </section>
    </div>
  );
}

function SyncSection() {
  const sync = useSyncStatus();
  const now = useNow();
  const [entering, setEntering] = useState(false);
  const [typed, setTyped] = useState("");
  const [copied, setCopied] = useState("");

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      setCopied("");
    }
  };

  if (!sync.code) {
    return (
      <section className="section">
        <h2 className="h2">Sync across devices</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Right now your progress lives in this browser only. Turn on sync to pick up where you left off on your phone, laptop, or any other device.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn" onClick={() => void startNewSync()}>
            Turn on sync
          </button>
          <button className="btn btn-ghost" aria-expanded={entering} onClick={() => setEntering((v) => !v)}>
            I have a code from another device
          </button>
        </div>
        {entering ? (
          <form
            className="sync-join"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim()) void joinSync(typed);
            }}
          >
            <input className="field" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="abcd-efgh-jkmn-pqrs-tuvw" aria-label="Sync code" autoComplete="off" autoCapitalize="none" spellCheck={false} />
            <button className="btn" type="submit" disabled={!typed.trim()}>
              Connect
            </button>
          </form>
        ) : null}
        {sync.state === "error" ? <p className="sync-error">{sync.message}</p> : null}
      </section>
    );
  }

  const line =
    sync.state === "syncing"
      ? "Syncing"
      : sync.state === "error"
        ? sync.message
        : sync.at && now
          ? `Synced ${ago(Math.max(0, now - sync.at))}. Changes go up every few minutes while you practice, and right away when you leave.`
          : "Sync is on.";
  return (
    <section className="section">
      <h2 className="h2">Sync across devices</h2>
      <p className={sync.state === "error" ? "sync-error" : "muted"} style={{ marginTop: 0 }}>
        {line}
      </p>
      <div className="sync-connect">
        <strong>Connect another device</strong>
        <span className="muted">Open the link on it, or type this code into its Settings. Keep the code private: anyone with it can see and change your progress.</span>
      </div>
      <div className="sync-code tnum">{formatCode(sync.code)}</div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
        <button className="btn" onClick={() => void copy(syncLink(sync.code!), "link")}>
          {copied === "link" ? "Link copied" : "Copy link"}
        </button>
        <button className="btn btn-ghost" onClick={() => void copy(formatCode(sync.code!), "code")}>
          {copied === "code" ? "Code copied" : "Copy code"}
        </button>
        <button className="btn btn-ghost" onClick={() => void syncNow()} disabled={sync.state === "syncing"}>
          Sync now
        </button>
        <button
          className="btn btn-ghost"
          onClick={() => {
            if (window.confirm("Stop syncing on this device? Your progress stays here, and stays on your other devices.")) stopSync();
          }}
        >
          Turn off on this device
        </button>
      </div>
    </section>
  );
}
