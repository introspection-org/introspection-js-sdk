"use client";

import Link from "next/link";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { AAuthLogo } from "./aauth-logo";

type Exchange = {
  id: number;
  from: string;
  to: string;
  label: string;
  request: string;
  response: string;
  status: number;
  repeats: number;
  turn: number;
};
type Email = {
  index: number;
  turn: number;
  to: string;
  item: string;
  reasons: string[];
  code: string;
  budget: { suggested: number | null } | null;
  decided: boolean;
};
type Scenario = { id: string; title: string; prompt: string; hint: string };
type Snapshot = {
  prompt?: string;
  busy: boolean;
  chat: { from: "Sam" | "Agent"; text: string }[];
  error?: string;
  mission?: {
    s256: string;
    budget_cents: number;
    spent_cents: number;
    terminated?: string;
  };
  exchanges: Exchange[];
  inbox: Email[];
};
type Decide = (
  email: Email,
  verdict: "approve" | "decline",
  budget?: number,
) => void;

const PARTY: Record<string, { name: string; mark: string; host: string }> = {
  Tools: {
    name: "the agent's tools",
    mark: "T",
    host: "travel-agent recipe, in its sandbox",
  },
  Acme: { name: "Acme", mark: "A", host: "ps.acme.localhost" },
  "Booking provider": {
    name: "the booking provider",
    mark: "B",
    host: "booking.flightsector.localhost",
  },
};

const TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|\b(-?\d+(?:\.\d+)?)\b|^(GET|POST|PUT|PATCH|DELETE|HTTP\/1\.1)\b|^([A-Za-z-]+)(?=: )|^(cedar is_authorized|decision: \w+)/gm;

/** The colouring the PAP site gives its exchanges: methods, headers, keys, strings, numbers. */
function highlight(text: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const [whole, str, colon, num, method, header, note] = m;
    if (str) {
      out.push(
        <span key={i} className={colon ? "k" : "s"}>
          {str}
        </span>,
      );
      if (colon) out.push(colon);
    } else if (num)
      out.push(
        <span key={i} className="n">
          {num}
        </span>,
      );
    else if (method)
      out.push(
        <span key={i} className="m">
          {method}
        </span>,
      );
    else if (header)
      out.push(
        <span key={i} className="h">
          {header}
        </span>,
      );
    else if (note)
      out.push(
        <span key={i} className="m">
          {note}
        </span>,
      );
    else out.push(whole);
    last = i + whole.length;
  }
  out.push(text.slice(last));
  return out.map((part, i) => <Fragment key={i}>{part}</Fragment>);
}

function tone(status: number) {
  if (status >= 200 && status < 300) return status === 202 ? "wait" : "ok";
  if (status === 401) return "ask";
  return "no";
}

function sees(parties: string[]) {
  const names = parties.map((p) => PARTY[p]?.name ?? p);
  const list =
    names.length > 1
      ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
      : names[0];
  return `What ${list} ${names.length > 1 || names[0].startsWith("the") ? "see" : "sees"}`;
}

function Inbox({
  email,
  busy,
  onDecide,
}: {
  email: Email;
  busy: boolean;
  onDecide: Decide;
}) {
  const [budget, setBudget] = useState(email.budget?.suggested ?? 3000);
  return (
    <div className={`mail ${email.decided ? "mail-done" : ""}`}>
      <div className="mail-head">
        <span className="mail-to">{email.to}&apos;s inbox</span>
        <span>from Acme Travel Approvals</span>
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
              onDecide(email, "approve", email.budget ? budget : undefined)
            }
          >
            {email.to.startsWith("Sam") ? "Accept" : "Approve"}
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => onDecide(email, "decline")}
          >
            Decline
          </button>
        </div>
      )}
    </div>
  );
}

function Moment(props: {
  title: string;
  calls: Exchange[];
  emails: Email[];
  busy: boolean;
  shown: boolean;
  onShow: () => void;
  onDecide: Decide;
}) {
  const { title, calls, emails, busy, shown, onShow, onDecide } = props;
  const parties = [...new Set(calls.map((x) => x.to))];
  return (
    <section className={`moment ${shown ? "moment-shown" : ""}`}>
      <h3>{title}</h3>
      {parties.length > 0 && (
        <>
          <div className="sees-head">
            <span className="mark">{PARTY[parties[0]]?.mark ?? "?"}</span>
            {sees(parties)}
          </div>
          <div className="sees-box">
            {calls.map((x) => (
              <div key={x.id} className="seen">
                <span className="seen-who">{PARTY[x.to]?.name ?? x.to}</span>
                <span>
                  {x.label}
                  {x.repeats > 1 && ` ×${x.repeats}`}
                </span>
                <span className={`pill ${tone(x.status)}`}>{x.status}</span>
              </div>
            ))}
          </div>
        </>
      )}
      {emails.map((email) => (
        <Inbox
          key={email.index}
          email={email}
          busy={busy}
          onDecide={onDecide}
        />
      ))}
      {calls.length > 0 && (
        <button className="details-toggle" onClick={onShow}>
          <span className="braces">{"{ }"}</span>{" "}
          {shown ? "Showing request details →" : "Show request details"}
        </button>
      )}
    </section>
  );
}

export function AAuthDemo({ scenarios }: { scenarios: Scenario[] }) {
  const [state, setState] = useState<Snapshot | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const seenEnd = useRef<HTMLDivElement>(null);
  const detailsEnd = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/demo/state", { cache: "no-store" });
    setState(await response.json());
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  const chatCount = state?.chat.length ?? 0;
  const callCount = state?.exchanges.length ?? 0;
  const mailCount = state?.inbox.length ?? 0;
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "nearest" });
  }, [chatCount]);
  useEffect(() => {
    seenEnd.current?.scrollIntoView({ block: "nearest" });
    if (picked === null)
      detailsEnd.current?.scrollIntoView({ block: "nearest" });
  }, [callCount, mailCount, picked]);

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
  const turns = [
    ...new Set([
      ...state.exchanges.map((x) => x.turn),
      ...state.inbox.map((e) => e.turn),
    ]),
  ].sort((a, b) => a - b);
  const latestCallTurn = state.exchanges.at(-1)?.turn;
  const shownTurn = picked ?? latestCallTurn;
  const details = state.exchanges.filter((x) => x.turn === shownTurn);
  const send = () => {
    if (!prompt.trim()) return;
    if (!started) setPicked(null);
    act({ action: started ? "send" : "start", prompt });
    setPrompt("");
  };
  const decide: Decide = (email, verdict, budget) =>
    act({ action: "decide", email: email.index, verdict, budget });

  return (
    <div className="ademo">
      <header className="ademo-head">
        <div>
          <div className="brand">
            <AAuthLogo />
            <span className="step-label">
              -11 · three-party, with a mission · on Introspection
            </span>
          </div>
          <h1>Flight Sector&apos;s agent books Sam&apos;s trip for Acme</h1>
        </div>
        <div className="ademo-controls">
          <Link href="/" className="link">
            The code behind it
          </Link>
          {started && (
            <button
              className="secondary"
              onClick={() => {
                setPicked(null);
                act({ action: "reset" });
              }}
              disabled={sending}
            >
              Start over
            </button>
          )}
        </div>
      </header>

      <div className="stage">
        <div className="phone">
          <div className="phone-screen">
            <div className="phone-head">
              <span className="avatar">F</span>
              <div>
                <strong>Flight Sector</strong>
                <span>Acme&apos;s travel agent</span>
              </div>
            </div>
            <div className="phone-chat">
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
              <div ref={chatEnd} />
            </div>
            {!state.busy && (
              <div className="phone-composer">
                <textarea
                  rows={2}
                  value={prompt}
                  placeholder={
                    started ? "Reply as Sam" : "Message Flight Sector as Sam"
                  }
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  aria-label="Sam's message"
                />
                <button
                  onClick={send}
                  disabled={sending || !prompt.trim()}
                  aria-label="Send"
                >
                  ↑
                </button>
              </div>
            )}
          </div>
          {hint && <p className="hint">{hint}</p>}
        </div>

        <div className="pane">
          <div className="pane-head">
            <div className="step-label">
              {started ? (state.busy ? "In progress" : "Done") : "Ready"}
            </div>
            <h2>
              {started ? "What each party sees" : "Type what Sam asks for"}
            </h2>
            <p>
              {started
                ? "Flight Sector's travel-agent recipe runs on Introspection. Its egress signs every call, and runs Flight Sector's Cedar rails before Acme is asked. Acme's Person Server speaks for Sam: Dana approves the trip once, and anything over its budget."
                : "Pick a sample or type your own: where, when, cabin, hotel and a budget. The travel-agent recipe proposes the trip to Acme, then books within it."}
            </p>
            {state.mission && (
              <div className="mission">
                Mission <code>{state.mission.s256.slice(0, 10)}…</code> · budget
                $
                {Math.round(state.mission.budget_cents / 100).toLocaleString(
                  "en-US",
                )}{" "}
                · spent $
                {Math.round(state.mission.spent_cents / 100).toLocaleString(
                  "en-US",
                )}
                {state.mission.terminated && ` · ${state.mission.terminated}`}
              </div>
            )}
          </div>
          <div className="pane-body">
            {turns.map((turn) => (
              <Moment
                key={turn}
                title={state.chat[turn]?.text ?? "Working…"}
                calls={state.exchanges.filter((x) => x.turn === turn)}
                emails={state.inbox.filter((e) => e.turn === turn)}
                busy={sending}
                shown={turn === shownTurn}
                onShow={() => setPicked(turn)}
                onDecide={decide}
              />
            ))}
            <div ref={seenEnd} />
          </div>
        </div>

        <div className="pane details">
          <div className="pane-head">
            <div className="step-label">
              <span className="braces">{"{ }"}</span> Request details
            </div>
            {picked !== null && (
              <button className="follow" onClick={() => setPicked(null)}>
                Follow the latest
              </button>
            )}
          </div>
          <div className="pane-body">
            {details.length === 0 && (
              <p className="muted">
                Each request Introspection&apos;s egress sends for the agent
                appears here, as it arrived, signed.
              </p>
            )}
            {details.map((x) => (
              <div key={x.id} className="exchange">
                <div className="exchange-head">
                  <span className="dir">
                    {x.from} ↔ {PARTY[x.to]?.host ?? x.to}
                  </span>
                  <span className="kind">
                    {x.label}
                    {x.repeats > 1 && ` ×${x.repeats}`}
                  </span>
                </div>
                <pre>
                  {highlight(x.request)}
                  {"\n\n"}
                  {highlight(x.response)}
                </pre>
              </div>
            ))}
            <div ref={detailsEnd} />
          </div>
        </div>
      </div>
    </div>
  );
}
