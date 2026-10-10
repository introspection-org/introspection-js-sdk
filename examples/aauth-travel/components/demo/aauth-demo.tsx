"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

type Exchange = {
  id: number;
  from: string;
  to: string;
  label: string;
  request: string;
  response: string;
  status: number;
  repeats: number;
};
type Email = {
  index: number;
  to: string;
  item: string;
  reasons: string[];
  code: string;
  budget: { suggested: number | null } | null;
  decided: boolean;
};
type FlowEvent = { seq: number; type: string; summary: string };
type Scenario = { id: string; title: string; prompt: string; hint: string };
type Snapshot = {
  prompt?: string;
  busy: boolean;
  chat: { from: "Sam" | "Agent"; text: string }[];
  error?: string;
  mission?: { s256: string; budget_cents: number };
  exchanges: Exchange[];
  events: FlowEvent[];
  inbox: Email[];
};

function tone(status: number) {
  if (status >= 200 && status < 300) return status === 202 ? "wait" : "ok";
  if (status === 401) return "ask";
  return "no";
}

function Inbox({
  email,
  busy,
  onDecide,
}: {
  email: Email;
  busy: boolean;
  onDecide: (verdict: "approve" | "decline", budget?: number) => void;
}) {
  const [budget, setBudget] = useState(email.budget?.suggested ?? 3000);
  return (
    <div className={`mail ${email.decided ? "mail-done" : ""}`}>
      <div className="mail-head">
        <span className="mail-to">{email.to}&apos;s inbox</span>
        <span className="mail-from">from Acme Travel Approvals</span>
      </div>
      <div className="mail-item">{email.item.replace(/^#+\s*/gm, "")}</div>
      <ul>
        {email.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {email.decided ? (
        <div className="mail-status">Answered</div>
      ) : (
        <div className="mail-actions">
          {email.budget && (
            <label>
              Budget $
              <input
                type="number"
                min={1}
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
              />
            </label>
          )}
          <button
            disabled={busy}
            onClick={() =>
              onDecide("approve", email.budget ? budget : undefined)
            }
          >
            {email.to.startsWith("Sam") ? "Accept" : "Approve"}
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => onDecide("decline")}
          >
            Decline
          </button>
        </div>
      )}
    </div>
  );
}

export function AAuthDemo({ scenarios }: { scenarios: Scenario[] }) {
  const [state, setState] = useState<Snapshot | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const wireEnd = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/demo/state", { cache: "no-store" });
    setState(await response.json());
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  const exchangeCount = state?.exchanges.length ?? 0;
  useEffect(() => {
    wireEnd.current?.scrollIntoView({ block: "nearest" });
  }, [exchangeCount]);

  const act = async (body: Record<string, unknown>) => {
    setSending(true);
    try {
      const response = await fetch("/api/demo/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setState(await response.json());
    } finally {
      setSending(false);
    }
  };

  if (!state) return null;
  const started = Boolean(state.prompt);
  const waitingOn = state.inbox.find((e) => !e.decided);
  const hint = scenarios.find(
    (s) => s.prompt === (state.prompt ?? prompt),
  )?.hint;
  const lastId = state.exchanges.at(-1)?.id;
  const rails = state.exchanges.filter((x) => x.to === "Rails");

  return (
    <div className="ademo">
      <header className="ademo-head">
        <div>
          <div className="eyebrow">AAuth -11 · three-party, with a mission</div>
          <h1>Flight Sector&apos;s agent books Sam&apos;s trip for Acme</h1>
          <p className="ademo-lede">
            Flight Sector&apos;s Cedar rails check every booking first. Then
            Acme&apos;s Person Server speaks for Sam: Dana, Sam&apos;s manager,
            approves the trip once and anything over its budget. Every request
            is signed by the agent&apos;s own key.
          </p>
        </div>
        <div className="ademo-controls">
          <Link href="/" className="link">
            The code behind it
          </Link>
          {started && (
            <button
              className="secondary"
              onClick={() => act({ action: "reset" })}
              disabled={sending}
            >
              Start over
            </button>
          )}
        </div>
      </header>

      <section className="columns">
        <div className="pane">
          <h2>Sam and Flight Sector&apos;s agent</h2>
          <div className="bubbles">
            {!started && (
              <div className="ideas">
                <span className="muted">Try asking for…</span>
                {scenarios.map((s) => (
                  <button
                    key={s.id}
                    className={`idea ${s.prompt === prompt ? "idea-on" : ""}`}
                    onClick={() => setPrompt(s.prompt)}
                  >
                    <span className="idea-title">{s.title}</span>
                    {s.prompt}
                  </button>
                ))}
              </div>
            )}
            {state.chat.map((line, i) => (
              <div
                key={i}
                className={`bubble ${line.from === "Sam" ? "sam" : "agent"}`}
              >
                {line.text}
              </div>
            ))}
            {state.busy && !waitingOn && (
              <div className="bubble agent working">…</div>
            )}
            {state.busy && waitingOn && (
              <div className="waiting">
                Waiting for {waitingOn.to} to answer Acme&apos;s email →
              </div>
            )}
            {state.error && <div className="error">{state.error}</div>}
          </div>
          {!started && (
            <div className="composer">
              <textarea
                rows={3}
                value={prompt}
                placeholder="Type what Sam asks for: where, when, cabin, hotel, budget…"
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && prompt.trim()) {
                    e.preventDefault();
                    act({ action: "start", prompt });
                  }
                }}
                aria-label="Sam's message"
              />
              <button
                onClick={() => act({ action: "start", prompt })}
                disabled={sending || !prompt.trim()}
              >
                Send as Sam
              </button>
            </div>
          )}
          {hint && <p className="muted hint">{hint}</p>}
        </div>

        <div className="pane">
          <h2>What the rails, Acme and the provider see</h2>
          {state.mission && (
            <div className="mission">
              Mission <code>{state.mission.s256.slice(0, 10)}…</code> · budget $
              {Math.round(state.mission.budget_cents / 100).toLocaleString(
                "en-US",
              )}
            </div>
          )}
          {state.inbox.map((email) => (
            <Inbox
              key={email.index}
              email={email}
              busy={sending}
              onDecide={(verdict, budget) =>
                act({ action: "decide", email: email.index, verdict, budget })
              }
            />
          ))}
          <ul className="events">
            {state.events.length === 0 && rails.length === 0 && (
              <li className="muted">Nothing yet.</li>
            )}
            {rails.map((x) => (
              <li key={`rails-${x.id}`}>
                <span
                  className={`who rails ${x.status === 200 ? "" : "denied"}`}
                >
                  Rails
                </span>
                {x.label.replace(/^Cedar: /, "")}
              </li>
            ))}
            {state.events.map((event) => (
              <li key={event.seq}>
                <span
                  className={`who ${event.type.startsWith("acme") ? "acme" : "provider"}`}
                >
                  {event.type.startsWith("acme") ? "Acme" : "Provider"}
                </span>
                {event.summary}
              </li>
            ))}
          </ul>
        </div>

        <div className="pane wire">
          <h2>On the wire</h2>
          {state.exchanges.length === 0 && (
            <p className="muted">Every request appears here, signed.</p>
          )}
          {state.exchanges.map((x) => (
            <details key={x.id} open={x.id === lastId}>
              <summary>
                <span className={`badge ${tone(x.status)}`}>{x.status}</span>
                <span className="wire-route">
                  {x.from} → {x.to}
                </span>
                {x.label}
                {x.repeats > 1 && ` ×${x.repeats}`}
              </summary>
              <pre>{x.request}</pre>
              <pre className="response">{x.response}</pre>
            </details>
          ))}
          <div ref={wireEnd} />
        </div>
      </section>
    </div>
  );
}
