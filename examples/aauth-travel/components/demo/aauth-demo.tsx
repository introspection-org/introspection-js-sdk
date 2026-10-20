"use client";

import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { recipe } from "@/flow/recipe.mjs";

import { AAuthLogo, IntrospectionMark } from "./aauth-logo";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
type ToolError = { turn: number; tool: string; text: string };
type Scenario = { id: string; title: string; prompt: string; hint: string };
type Snapshot = {
  prompt?: string;
  busy: boolean;
  chat: { from: "Sam" | "Agent"; text: string }[];
  /** Tool calls that failed, each under the chat line that followed it. */
  toolErrors?: ToolError[];
  error?: string;
  /** The run's conversation in the Introspection app. */
  /** The run's task, which is its conversation in Introspection. */
  taskId?: string;
  /** Where the Introspection app shows the project's conversations. */
  conversations?: string;
  hosts?: Record<string, string>;
  working?: boolean;
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

const PARTY: Record<string, { name: string; mark: string; host?: string }> = {
  Tools: {
    name: "Tools",
    mark: "T",
    host: "travel-agent recipe, in its sandbox",
  },
  Acme: { name: "Acme", mark: "A" },
  "Booking provider": { name: "Booking provider", mark: "B" },
  Browserbase: { name: "Browserbase", mark: "W" },
  "Flight Sector AS": { name: "Flight Sector AS", mark: "F" },
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
  return parties.map((p) => PARTY[p]?.name ?? p).join(" · ");
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
  // The approver types the code Acme emailed; the page plays that out, a
  // digit at a time, before it sends the answer.
  const [typed, setTyped] = useState<string | null>(null);
  const answer = (verdict: "approve" | "decline") => {
    if (typed !== null) return;
    setTyped("");
    const digits = email.code.split("");
    digits.forEach((_, i) =>
      setTimeout(() => setTyped(email.code.slice(0, i + 1)), (i + 1) * 120),
    );
    setTimeout(
      () => {
        onDecide(
          email,
          verdict,
          verdict === "approve" && email.budget ? budget : undefined,
        );
        // A refused answer leaves the card open: let it be tried again.
        setTimeout(() => setTyped(null), 3000);
      },
      digits.length * 120 + 300,
    );
  };
  // Sam is the traveller, Dana his manager: each in their own colour.
  const who = email.to.startsWith("Sam") ? "mail-sam" : "mail-dana";
  return (
    <div className={`mail ${who} ${email.decided ? "mail-done" : ""}`}>
      <div className="mail-head">
        <span className="mail-to">
          <span className="mail-avatar" aria-hidden>
            {email.to.charAt(0)}
          </span>
          {email.to}&apos;s inbox
        </span>
        <span>from Acme Travel Approvals</span>
      </div>
      <div className="mail-item">
        <Markdown remarkPlugins={[remarkGfm]}>
          {email.item.replace(/^#+\s*/gm, "")}
        </Markdown>
      </div>
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
          <div className="mail-answer">
            <span className="mail-code" aria-label="Code from the email">
              {Array.from({ length: 6 }, (_, i) => (
                <span
                  key={i}
                  className={typed && typed.length > i ? "filled" : undefined}
                >
                  {typed?.[i] ?? ""}
                </span>
              ))}
            </span>
            <button
              disabled={busy || typed !== null}
              onClick={() => answer("approve")}
            >
              {email.to.startsWith("Sam") ? "Accept" : "Approve"}
            </button>
            <button
              className="secondary"
              disabled={busy || typed !== null}
              onClick={() => answer("decline")}
            >
              Decline
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The agent's failed tool calls, folded away under its reply. */
function Why({ errors }: { errors: ToolError[] }) {
  if (errors.length === 0) return null;
  return (
    <details className="why">
      <summary>why</summary>
      {errors.map((e, i) => (
        <div key={i} className="why-line">
          <code>{e.tool}</code>: {e.text}
        </div>
      ))}
    </details>
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
      <div className="moment-title">
        <Markdown remarkPlugins={[remarkGfm]}>{title}</Markdown>
      </div>
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

/**
 * The run's conversation in Introspection, as an address bar: its URL to copy
 * or open, or another conversation's URL or id to paste and open.
 */
function ConversationBar({
  base,
  taskId,
  onLoad,
}: {
  base?: string;
  taskId?: string;
  onLoad: (taskId: string) => void;
}) {
  // Shown as a browser shows an address: no scheme, the host set off from the path.
  const scheme = base?.match(/^https?:\/\//)?.[0] ?? "https://";
  // Before a run, the project's conversations; during one, that run's.
  const current = base
    ? `${base}${taskId ?? ""}`.slice(scheme.length)
    : (taskId ?? "");
  const [text, setText] = useState(current);
  useEffect(() => setText(current), [current]);
  const open = () => {
    const value = text.trim();
    if (!value) return;
    const url = /^https?:\/\//.test(value)
      ? value
      : value.includes("/")
        ? `${scheme}${value}`
        : `${base}${value}`;
    window.open(url, "_blank", "noreferrer");
  };
  // Enter loads (or reloads) the conversation a URL or id names; only the icon
  // opens it. The id is the last one: a project's id can come first.
  const pasted = text
    .match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)
    ?.at(-1);
  return (
    <form
      className="conversation-bar"
      onSubmit={(e) => {
        e.preventDefault();
        if (pasted) onLoad(pasted);
      }}
    >
      <span className="conversation-bar-icon" aria-hidden>
        ⓘ
      </span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        spellCheck={false}
        placeholder="Paste a conversation URL or id"
        aria-label="This run's conversation in Introspection, or another to load"
      />
      <button
        type="button"
        onClick={open}
        disabled={!text.trim()}
        title="Open in Introspection"
        aria-label="Open in Introspection"
      >
        <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
          <path
            d="M9 2h5v5M14 2 7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </form>
  );
}

/** Copies a request and its response, as shown, and says so for a moment. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-exchange"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title="Copy the request and response"
      aria-label="Copy the request and response"
    >
      {copied ? (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path
            d="M3 8.5 6.5 12 13 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <rect
            x="5"
            y="5"
            width="9"
            height="9"
            rx="1.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
        </svg>
      )}
    </button>
  );
}

export function AAuthDemo({ scenarios }: { scenarios: Scenario[] }) {
  const [state, setState] = useState<Snapshot | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const chatBox = useRef<HTMLDivElement>(null);
  const seenPane = useRef<HTMLDivElement>(null);
  const detailsPane = useRef<HTMLDivElement>(null);
  // Whether the reader is at a pane's end, so new and growing content keeps
  // it there; scrolling up to read leaves it where they put it.
  const seenAtEnd = useRef(true);
  const detailsAtEnd = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  // Grow with the text, as a chat app's input does, whether typed or picked.
  useEffect(() => {
    const box = composer.current;
    if (!box) return;
    box.style.height = "auto";
    // scrollHeight leaves out the borders; without them the box is a little
    // short of its text and shows a scrollbar for a single line.
    const borders = box.offsetHeight - box.clientHeight;
    if (prompt) box.style.height = `${box.scrollHeight + borders}px`;
    box.style.overflowY =
      box.scrollHeight + borders > parseFloat(getComputedStyle(box).maxHeight)
        ? "auto"
        : "hidden";
  }, [prompt]);

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
  // Follow the chat as each reply streams in, not only when a new one starts.
  const chatSize =
    state?.chat.reduce((n, line) => n + line.text.length, 0) ?? 0;
  useEffect(() => {
    const box = chatBox.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [chatCount, chatSize, state?.working]);
  // Every update keeps a pane that was at its end there, after layout, so a
  // card that grows once rendered is not left half below the edge. Picking a
  // turn moves only the request details, to the top of that turn's requests.
  useLayoutEffect(() => {
    const seen = seenPane.current;
    if (seen && seenAtEnd.current) seen.scrollTop = seen.scrollHeight;
    const details = detailsPane.current;
    if (details && picked === null && detailsAtEnd.current)
      details.scrollTop = details.scrollHeight;
  }, [state, picked]);
  useEffect(() => {
    // Following the latest again follows the end again.
    detailsAtEnd.current = picked === null;
    if (picked !== null) detailsPane.current?.scrollTo({ top: 0 });
  }, [picked]);
  const atEnd = (pane: HTMLDivElement) =>
    pane.scrollHeight - pane.scrollTop - pane.clientHeight < 48;

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
  const started = Boolean(state.prompt || state.taskId || state.chat.length);
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
        <div className="ademo-row">
          <div className="brand">
            <AAuthLogo />
            <span className="step-label">
              -11 · three-party, with a mission · on{" "}
              <span className="on-introspection">
                <IntrospectionMark />
                Introspection
              </span>
            </span>
          </div>
          <div className="ademo-controls">
            <a
              href={`${recipe.repository}/tree/${recipe.ref}`}
              target="_blank"
              rel="noopener noreferrer"
              className="control"
            >
              Recipe
            </a>
            <a
              href="/walkthrough"
              target="_blank"
              rel="noopener noreferrer"
              className="control"
            >
              Walkthrough
            </a>
            {started && (
              <button
                className="control"
                onClick={() => {
                  setPicked(null);
                  act({ action: "reset" });
                }}
                disabled={sending}
              >
                <span aria-hidden>↺</span> Restart
              </button>
            )}
          </div>
        </div>
        <div className="ademo-title">
          <h1>Flight Sector&apos;s agent books Sam&apos;s trip for Acme</h1>
          <ConversationBar
            base={state?.conversations}
            taskId={state?.taskId}
            onLoad={(id) => {
              setPicked(null);
              act({ action: "join", taskId: id });
            }}
          />
        </div>
      </header>

      <div className="stage">
        <div className="phone">
          <div className="phone-screen">
            <div className="phone-status" aria-hidden>
              <span>9:41</span>
              <span>5G</span>
            </div>
            <div className="phone-head">
              <span className="avatar">F</span>
              <div>
                <strong>Flight Sector</strong>
                <span>Acme&apos;s travel agent</span>
              </div>
            </div>
            <div className="phone-chat" ref={chatBox}>
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
              {state.chat.map((line, i) => {
                // Under the agent's reply that follows them, or ahead of Sam's.
                const why = (
                  <Why
                    errors={(state.toolErrors ?? []).filter(
                      (e) => e.turn === i,
                    )}
                  />
                );
                return (
                  <Fragment key={i}>
                    {line.from === "Sam" && why}
                    <div
                      className={`bubble ${line.from === "Sam" ? "sam" : "agent"}`}
                    >
                      {line.from === "Agent" ? (
                        <Markdown remarkPlugins={[remarkGfm]}>
                          {line.text}
                        </Markdown>
                      ) : (
                        line.text
                      )}
                    </div>
                    {line.from === "Agent" && why}
                  </Fragment>
                );
              })}
              <Why
                errors={(state.toolErrors ?? []).filter(
                  (e) => e.turn >= state.chat.length,
                )}
              />
              {state.working && !waitingOn && (
                <div className="bubble agent working">…</div>
              )}
              {state.error && <div className="error">{state.error}</div>}
              <div ref={chatEnd} />
            </div>
            <div className="phone-composer">
              <textarea
                ref={composer}
                rows={1}
                value={prompt}
                placeholder={
                  started ? "Reply as Sam" : "Message Flight Sector as Sam"
                }
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!state.working) send();
                  }
                }}
                aria-label="Sam's message"
              />
              {state.working ? (
                <button
                  onClick={() => act({ action: "stop" })}
                  disabled={sending}
                  aria-label="Stop"
                >
                  ■
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={sending || !prompt.trim()}
                  aria-label="Send"
                >
                  ↑
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="pane">
          <div className="pane-head">
            <div className="step-label">Behind the chat</div>
            <span className="pane-status">
              {started ? (state.busy ? "In progress" : "Done") : "Ready"}
            </span>
          </div>
          {(!started || hint || state.mission) && (
            <div className="pane-intro">
              {!started && (
                <p>
                  Pick a sample or type your own: where, when, cabin, hotel and
                  a budget. Flight Sector&apos;s travel-agent recipe runs on
                  Introspection: its egress signs every call and runs Flight
                  Sector&apos;s Cedar rails before Acme is asked, and
                  Acme&apos;s Person Server speaks for Sam, so Dana approves the
                  trip once and anything over its budget.
                </p>
              )}
              {hint && (
                <p className="hint">
                  <strong>Next:</strong> {hint}
                </p>
              )}
              {state.mission && (
                <div className="mission">
                  Mission <code>{state.mission.s256.slice(0, 10)}…</code> ·
                  budget $
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
          )}
          <div
            className="pane-body"
            ref={seenPane}
            onScroll={(e) => (seenAtEnd.current = atEnd(e.currentTarget))}
          >
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
          {details.length === 0 && (
            <div className="pane-intro">
              <p>
                Each request Introspection&apos;s egress sends for the agent
                appears here, as it arrived, signed.
              </p>
            </div>
          )}
          <div
            className="pane-body"
            ref={detailsPane}
            onScroll={(e) => (detailsAtEnd.current = atEnd(e.currentTarget))}
          >
            {details.map((x) => (
              <div key={x.id} className="exchange">
                <div className="exchange-head">
                  <span className="dir">
                    {x.from} ↔{" "}
                    {state?.hosts?.[x.to] ?? PARTY[x.to]?.host ?? x.to}
                  </span>
                  <span className="kind">
                    {x.label}
                    {x.repeats > 1 && ` ×${x.repeats}`}
                  </span>
                  <CopyButton text={`${x.request}\n\n${x.response}`} />
                </div>
                <pre>
                  {highlight(x.request)}
                  {"\n\n"}
                  {highlight(x.response)}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
