"use client";

import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  Composer,
  type Exchange,
  Moment,
  type Parties,
  Phone,
  RequestDetails,
  useFollow,
} from "introspection-example-travel-demo-ui";

type Operation = {
  operation_id: string;
  revision: string;
  summary: string;
  terms?: Record<string, unknown>;
  expires_at: string;
};
type ChatLine = {
  from: "Sam" | "Atlas";
  text: string;
  signIn?: string;
  choices?: { id: string; label: string }[];
  approval?: {
    company: string;
    operation: Operation;
    mismatch?: string;
    answer?: "approved" | "declined";
  };
};
type Seen = { turn: number; from: string; text: string; note?: string };
type Snapshot = {
  step: "start" | "sign-in" | "choose" | "approve" | "done" | "disconnected";
  chat: ChatLine[];
  seen: Seen[];
  exchanges: Exchange[];
  session?: {
    sid: string;
    signedIn: boolean;
    scopes: string[];
    conversation?: string;
  };
  records: {
    booking: { reference: string; flight: string; seat: string };
    changes: { flight: string; operation_id?: string }[];
  };
  error?: string;
};

/**
 * Text from the demo's own lines and from an operation's `summary`: bold and
 * lists only. Links, images and HTML stay text, so a summary can't send Sam
 * elsewhere while he decides (Operations 3).
 */
function Rich({ text }: { text: string }) {
  const inline = (line: string) =>
    line
      .split(/(\*\*[^*]+\*\*)/)
      .map((part, i) =>
        part.startsWith("**") && part.endsWith("**") ? (
          <strong key={i}>{part.slice(2, -2)}</strong>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      );
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length)
      blocks.push(
        <ul key={blocks.length}>
          {list.map((item, i) => (
            <li key={i}>{inline(item)}</li>
          ))}
        </ul>,
      );
    list = [];
  };
  for (const line of text.split("\n")) {
    if (/^[-*] /.test(line)) list.push(line.slice(2));
    else {
      flush();
      if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
    }
  }
  flush();
  return <>{blocks}</>;
}

const TERM_LABELS: Record<string, string> = {
  booking_reference: "Booking",
  from_flight: "From",
  to_flight: "To",
  departs: "Departs",
  arrives: "Arrives",
  fare_difference: "Fare difference",
  charged_to: "Charged to",
};
const shownTerm = (value: unknown) => {
  const money = value as { amount?: string; currency?: string } | null;
  return money && typeof money === "object" && money.amount
    ? `${money.amount} ${money.currency ?? ""}`
    : String(value);
};

/** Sam's approval, in Atlas's own interface: the Company's name and the exact terms. */
function Approval({
  card,
  busy,
  onAnswer,
}: {
  card: NonNullable<ChatLine["approval"]>;
  busy: boolean;
  onAnswer: (verdict: "approve" | "decline") => void;
}) {
  const { operation } = card;
  return (
    <div className={`mail mail-sam approval ${card.answer ? "mail-done" : ""}`}>
      <div className="mail-head">
        <span className="mail-to">
          <span className="mail-avatar" aria-hidden>
            {card.company.charAt(0)}
          </span>
          {card.company} asks you to approve
        </span>
      </div>
      <div className="mail-item">
        <Rich text={operation.summary} />
      </div>
      {operation.terms && (
        <table className="terms">
          <tbody>
            {Object.entries(operation.terms).map(([k, v]) => (
              <tr key={k}>
                <td>{TERM_LABELS[k] ?? k}</td>
                <td>{shownTerm(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {card.mismatch && <p className="error">{card.mismatch}</p>}
      <p className="approval-meta">
        <code>{operation.operation_id}</code> · revision{" "}
        <code>{operation.revision}</code> · until{" "}
        {new Date(operation.expires_at).toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        })}
      </p>
      {card.answer ? (
        <div className="mail-status">
          {card.answer === "approved" ? "Approved" : "Declined"}
        </div>
      ) : (
        <div className="mail-actions">
          <div className="mail-answer">
            <button disabled={busy} onClick={() => onAnswer("approve")}>
              Approve
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => onAnswer("decline")}
            >
              Decline
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const PARTY: Parties = {
  "Flight Sector": { name: "Flight Sector", mark: "F" },
  Atlas: { name: "Atlas", mark: "A" },
};

export function PapDemo({
  prompts,
  hosts,
  companyUrl,
}: {
  prompts: { title: string; prompt: string }[];
  hosts: Record<string, string>;
  companyUrl: string;
}) {
  const [state, setState] = useState<Snapshot | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/state", { cache: "no-store" });
    setState(await response.json());
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [refresh]);

  const chatSize =
    state?.chat.reduce((n, line) => n + line.text.length, 0) ?? 0;
  const { chatBox, seenPane, detailsPane, onSeenScroll, onDetailsScroll } =
    useFollow(`${state?.chat.length}:${chatSize}:${sending}`, state, picked);

  const act = async (body: Record<string, unknown>) => {
    setSending(true);
    try {
      const response = await fetch("/api/action", {
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
  const started = state.chat.length > 0;
  const turns = [
    ...new Set([
      ...state.exchanges.map((x) => x.turn),
      ...state.seen.map((s) => s.turn),
    ]),
  ].sort((a, b) => a - b);
  const shownTurn = picked ?? state.exchanges.at(-1)?.turn;
  const details = state.exchanges.filter((x) => x.turn === shownTurn);
  const lastAtlas = state.chat.findLastIndex((line) => line.from === "Atlas");
  const send = () => {
    if (!prompt.trim()) return;
    act({ action: "send", text: prompt });
    setPrompt("");
  };
  const { booking, changes } = state.records;

  return (
    <div className="ademo pap">
      <header className="ademo-head">
        <div className="ademo-row">
          <div className="brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/poppy.png" alt="" width={26} height={26} />
            <span className="step-label">
              Personal Agent Protocol · draft 0.3 · Session header, OAuth
              sign-in, Operations v2
            </span>
          </div>
          <div className="ademo-controls">
            <a
              href="https://personalagentprotocol.org/docs/0.3/spec"
              target="_blank"
              rel="noopener noreferrer"
              className="control"
            >
              Spec
            </a>
            <a
              href={`${companyUrl}/`}
              target="_blank"
              rel="noopener noreferrer"
              className="control"
            >
              Flight Sector
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
          <h1>Atlas rebooks Sam&apos;s delayed flight with Flight Sector</h1>
        </div>
      </header>

      <div className="stage">
        <Phone
          avatar="A"
          name="Atlas"
          subtitle="Sam's assistant"
          chatRef={chatBox}
          composer={
            <Composer
              value={prompt}
              onChange={setPrompt}
              onSend={send}
              placeholder={started ? "Reply as Sam" : "Message Atlas as Sam"}
              label="Sam's message"
              busy={sending}
            />
          }
        >
          {!started && (
            <div className="ideas">
              <span className="muted">Try asking for…</span>
              {prompts.map((s) => (
                <button
                  key={s.title}
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
            <Fragment key={i}>
              <div
                className={`bubble ${line.from === "Sam" ? "sam" : "agent"}`}
              >
                {line.from === "Atlas" ? <Rich text={line.text} /> : line.text}
                {line.signIn && state.step === "sign-in" && i === lastAtlas && (
                  <a className="sign-in" href={line.signIn}>
                    Sign in at Flight Sector
                  </a>
                )}
              </div>
              {line.approval && (
                <Approval
                  card={line.approval}
                  busy={sending}
                  onAnswer={(verdict) => act({ action: verdict })}
                />
              )}
              {line.choices && i === lastAtlas && (
                <div className="choices">
                  {line.choices.map((c) => (
                    <button
                      key={c.id}
                      className="secondary"
                      disabled={sending}
                      onClick={() => act({ action: "choose", option: c.id })}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}
            </Fragment>
          ))}
          {sending && <div className="bubble agent working">…</div>}
          {state.error && <div className="error">{state.error}</div>}
          <div />
        </Phone>

        <div className="pane">
          <div className="pane-head">
            <div className="step-label">Behind the chat</div>
            <span className="pane-status">
              {started ? (sending ? "In progress" : "Done") : "Ready"}
            </span>
          </div>
          <div className="pane-intro">
            {!started && (
              <p>
                Atlas is Sam&apos;s own assistant, and Flight Sector has never
                seen it before. It finds Flight Sector from its{" "}
                <code>poppy.json</code>, talks to its agent in a Session it
                names in a signed header on every request, has Sam sign in with
                plain OAuth when it needs his booking, and asks Sam before it
                approves anything that costs more.
              </p>
            )}
            {state.session && (
              <div className="mission">
                Session <code>{state.session.sid.slice(0, 10)}…</code> ·{" "}
                {state.session.signedIn
                  ? `signed in: ${state.session.scopes.join(" ")}`
                  : "signed out"}
                {state.session.conversation &&
                  ` · ${state.session.conversation}`}
              </div>
            )}
            <div className="mission records">
              Flight Sector&apos;s records: {booking.reference} on{" "}
              {booking.flight}, seat {booking.seat} · {changes.length}{" "}
              {changes.length === 1 ? "change" : "changes"}
            </div>
          </div>
          <div
            className="pane-body"
            ref={seenPane}
            onScroll={(e) => onSeenScroll(e.currentTarget)}
          >
            {turns.map((turn) => {
              const lines = state.seen.filter((s) => s.turn === turn);
              return (
                <Moment
                  key={turn}
                  title={<p>{state.chat[turn]?.text ?? "Working…"}</p>}
                  calls={state.exchanges.filter((x) => x.turn === turn)}
                  parties={PARTY}
                  shown={turn === shownTurn}
                  onShow={() => setPicked(turn)}
                >
                  {lines.length > 0 && (
                    <div className="talk">
                      <div className="talk-head">
                        The conversation, as Flight Sector sees it
                      </div>
                      {lines.map((line, i) => (
                        <div
                          key={i}
                          className={`talk-line ${line.from === "Atlas" ? "talk-atlas" : "talk-company"}`}
                        >
                          <span className="talk-who">{line.from}</span>
                          <span>
                            {line.text}
                            {line.note && (
                              <code className="talk-note">{line.note}</code>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </Moment>
              );
            })}
          </div>
        </div>

        <RequestDetails
          exchanges={details}
          parties={PARTY}
          hosts={hosts}
          empty={
            <p>
              Each request Atlas sends appears here as it went, credentials
              shortened, with its Session header decoded.
            </p>
          }
          onFollow={picked !== null ? () => setPicked(null) : undefined}
          paneRef={detailsPane}
          onScroll={onDetailsScroll}
        />
      </div>
    </div>
  );
}
