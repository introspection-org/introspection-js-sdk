"use client";

import { useCallback, useEffect, useState } from "react";

type Chat = {
  from: "sam" | "atlas";
  text: string;
  signIn?: string;
  choices?: { id: string; label: string }[];
};
type Seen = { from: string; text: string; data?: unknown; note?: string };
type Exchange = {
  id: string;
  label: string;
  request: string;
  response: string;
};
type Snapshot = {
  step: "start" | "sign-in" | "choose" | "done" | "disconnected";
  chat: Chat[];
  seen: Seen[];
  exchanges: Exchange[];
  result?: Record<string, string>;
  error?: string;
};

const RESULT_LABELS: Record<string, string> = {
  booking_reference: "Booking",
  flight: "New flight",
  seat: "Seat",
  fare_difference: "Fare difference",
  conversation: "Conversation",
};

export function Demo() {
  const [state, setState] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/state", { cache: "no-store" });
    setState(await response.json());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const act = async (action: string, option?: string) => {
    setBusy(true);
    try {
      const response = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, option }),
      });
      setState(await response.json());
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;
  const last = state.chat.at(-1);

  return (
    <div className="demo">
      <header className="demo-head">
        <div>
          <div className="eyebrow">Personal Agent Protocol 0.1</div>
          <h1>Atlas rebooks a delayed flight with Flight Sector</h1>
        </div>
        <button
          className="secondary"
          onClick={() => act("reset")}
          disabled={busy}
        >
          Start over
        </button>
      </header>

      <section className="pane chat">
        <h2>Sam and Atlas</h2>
        <div className="bubbles">
          {state.chat.map((line, i) => (
            <div key={i} className={`bubble ${line.from}`}>
              {line.text}
              {line.signIn &&
                i === state.chat.length - 1 &&
                state.step === "sign-in" && (
                  <a className="button" href={line.signIn}>
                    Sign in at Flight Sector
                  </a>
                )}
              {line.choices && state.step === "choose" && (
                <div className="choices">
                  {line.choices.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => act("choose", c.id)}
                      disabled={busy}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {state.step === "start" && (
            <button className="ask" onClick={() => act("ask")} disabled={busy}>
              Send: &ldquo;My QF74 to Sydney is delayed six hours…&rdquo;
            </button>
          )}
          {state.step === "done" && last?.from === "atlas" && (
            <button
              className="secondary"
              onClick={() => act("disconnect")}
              disabled={busy}
            >
              Disconnect Atlas from Flight Sector
            </button>
          )}
          {busy && <div className="bubble atlas working">…</div>}
          {state.error && <div className="error">{state.error}</div>}
        </div>
      </section>

      <section className="pane seen">
        <h2>What Flight Sector sees</h2>
        {state.seen.length === 0 && <p className="muted">Nothing yet.</p>}
        {state.seen.map((line, i) => (
          <div key={i} className="seen-line">
            <div className="seen-from">{line.from}</div>
            {line.text && <div>{line.text}</div>}
            {line.note && <div className="note">{line.note}</div>}
            {line.data !== undefined && (
              <pre className="data">{JSON.stringify(line.data, null, 2)}</pre>
            )}
          </div>
        ))}
        {state.result && (
          <dl className="result">
            {Object.entries(state.result).map(([k, v]) => (
              <div key={k}>
                <dt>{RESULT_LABELS[k] ?? k}</dt>
                <dd>
                  {k === "fare_difference" ? (v === "0" ? "none" : `$${v}`) : v}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="pane wire">
        <h2>On the wire</h2>
        {state.exchanges.length === 0 && (
          <p className="muted">Every request Atlas makes appears here.</p>
        )}
        {state.exchanges.map((exchange, i) => (
          <details key={exchange.id} open={i === state.exchanges.length - 1}>
            <summary>
              <span className="wire-index">{i + 1}</span>
              {exchange.label}
            </summary>
            <pre>{exchange.request}</pre>
            <pre className="response">{exchange.response}</pre>
          </details>
        ))}
      </section>
    </div>
  );
}
