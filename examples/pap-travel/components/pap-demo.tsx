"use client";

import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  BehindTheChat,
  Composer,
  type Exchange,
  Header,
  Ideas,
  Moment,
  type Parties,
  Phone,
  RequestDetails,
  Sees,
  useFollow,
} from "introspection-example-travel-demo-ui";

type Operation = {
  operation_id: string;
  revision: string;
  summary: string;
  terms?: Record<string, unknown>;
  expires_at: string;
};
type Card = {
  company: string;
  operation: Operation;
  mismatch?: string;
  answer?: "approved" | "declined";
};
type ChatLine = {
  from: "Sam" | "Atlas";
  text: string;
  signIn?: string;
  choices?: { id: string; label: string }[];
  approval?: Card;
};
type Seen = {
  turn: number;
  from: string;
  text: string;
  kind?: "authorization" | "operation" | "approval";
};
type Scenario = { id: string; title: string; prompt: string; hint: string };
type Snapshot = {
  step: "start" | "sign-in" | "choose" | "approve" | "done" | "disconnected";
  prompt?: string;
  busy: boolean;
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

const PARTY: Parties = {
  "Flight Sector": { name: "Flight Sector", mark: "F" },
  Atlas: { name: "Atlas", mark: "A" },
};

/** What each kind of event in the agents' conversation is, as a pill. */
const KIND = {
  authorization: { label: "sign-in", tone: "ask" },
  operation: { label: "approve?", tone: "wait" },
  approval: { label: "approved", tone: "ok" },
};

/**
 * The demo's own lines and an operation's `summary`: bold and lists only.
 * Links, images and HTML stay text, so a summary can't send Sam elsewhere
 * while he decides (Operations 3).
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

const TERMS: Record<string, string> = {
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

/**
 * Sam's approval of an operation, in Atlas's own interface (Operations 5):
 * the Company's name, its summary and terms. A sibling of aauth-travel's
 * Inbox card, with no emailed code: Sam is in the app that asks.
 */
function Approval({
  card,
  busy,
  onAnswer,
}: {
  card: Card;
  busy: boolean;
  onAnswer: (verdict: "approve" | "decline") => void;
}) {
  const { operation } = card;
  return (
    <div className={`mail mail-sam approval ${card.answer ? "mail-done" : ""}`}>
      <div className="mail-head">
        <span className="mail-to">
          <span className="mail-avatar" aria-hidden>
            S
          </span>
          Sam&apos;s approval
        </span>
        <span>from {card.company}</span>
      </div>
      <div className="mail-item">
        <Rich text={operation.summary} />
      </div>
      <ul>
        {Object.entries(operation.terms ?? {}).map(([k, v]) => (
          <li key={k}>
            {TERMS[k] ?? k}: {shownTerm(v)}
          </li>
        ))}
        <li>
          Operation <code>{operation.operation_id}</code>, until{" "}
          {new Date(operation.expires_at).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
          })}
        </li>
      </ul>
      {card.mismatch && <div className="error">{card.mismatch}</div>}
      {card.answer ? (
        <div className="mail-status">
          Answered: {card.answer === "approved" ? "approved" : "declined"}
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

export function PapDemo({
  scenarios,
  hosts,
  companyUrl,
}: {
  scenarios: Scenario[];
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
  const hint = scenarios.find(
    (s) => s.prompt === (state.prompt ?? prompt),
  )?.hint;
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
    if (!started) setPicked(null);
    act({ action: "send", text: prompt });
    setPrompt("");
  };
  const { session } = state;
  const { booking, changes } = state.records;

  return (
    <div className="ademo pap">
      <Header
        brand={
          <>
            <span className="poppy-mark">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/poppy.png" alt="" width={22} height={22} />
              Poppy
            </span>
            <span className="step-label">
              draft 0.3 · a Personal Agent, signed in, with operations
            </span>
          </>
        }
        controls={
          <>
            <a
              href="https://personalagentprotocol.org/docs/0.3/spec"
              target="_blank"
              rel="noopener noreferrer"
              className="control"
            >
              Spec
            </a>
            <a
              href={`${companyUrl}/.well-known/poppy.json`}
              target="_blank"
              rel="noopener noreferrer"
              className="control"
            >
              poppy.json
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
          </>
        }
        title={<>Atlas rebooks Sam&apos;s delayed flight with Flight Sector</>}
      />

      <div className="stage">
        <Phone
          avatar="A"
          name="Atlas"
          subtitle="Sam's personal agent"
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
            <Ideas prompts={scenarios} value={prompt} onPick={setPrompt} />
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
          {/* The chat's end: its gap keeps the last bubble off the composer. */}
          <div />
        </Phone>

        <BehindTheChat
          status={started ? (state.busy ? "In progress" : "Done") : "Ready"}
          intro={
            (!started || hint || session) && (
              <>
                {!started && (
                  <p>
                    Pick a sample or type your own. Atlas is Sam&apos;s own
                    agent, and Flight Sector has never seen it before: Atlas
                    finds it from its <code>poppy.json</code>, names its Session
                    in a signed header on every request, has Sam sign in with
                    plain OAuth when it needs his booking, and asks Sam before
                    it approves anything that costs more.
                  </p>
                )}
                {hint && (
                  <p className="hint">
                    <strong>Next:</strong> {hint}
                  </p>
                )}
                {session && (
                  <div className="mission">
                    Session <code>{session.sid.slice(0, 10)}…</code> ·{" "}
                    {session.signedIn
                      ? `signed in, ${session.scopes.join(" ")}`
                      : "signed out"}{" "}
                    · {booking.reference} on {booking.flight},{" "}
                    {changes.length === 0
                      ? "unchanged"
                      : changes.length === 1
                        ? "changed once"
                        : `changed ${changes.length} times`}
                  </div>
                )}
              </>
            )
          }
          paneRef={seenPane}
          onScroll={onSeenScroll}
        >
          {turns.map((turn) => {
            const lines = state.seen.filter((s) => s.turn === turn);
            return (
              <Moment
                key={turn}
                title={<Rich text={state.chat[turn]?.text ?? "Working…"} />}
                calls={state.exchanges.filter((x) => x.turn === turn)}
                parties={PARTY}
                shown={turn === shownTurn}
                onShow={() => setPicked(turn)}
              >
                {lines.length > 0 && (
                  <div className="talk">
                    <Sees
                      mark="F"
                      title="Flight Sector's agent, in the conversation"
                      rows={lines.map((line, i) => ({
                        key: i,
                        who: line.from,
                        what: line.text,
                        pill: line.kind && KIND[line.kind],
                      }))}
                    />
                  </div>
                )}
              </Moment>
            );
          })}
        </BehindTheChat>

        <RequestDetails
          exchanges={details}
          parties={PARTY}
          hosts={hosts}
          empty={
            <p>
              Each request Atlas sends Flight Sector appears here, as it went,
              with its Session header decoded.
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
