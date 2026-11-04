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
  ConversationBar,
  type Decide,
  type Email,
  type Exchange,
  Header,
  Ideas,
  Inbox,
  Moment,
  type Parties,
  Phone,
  RequestDetails,
  useFollow,
} from "introspection-example-travel-demo-ui";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
  approval?: Card;
};
type Scenario = { id: string; title: string; prompt: string; hint: string };
/** Flight Sector's side: the task its agent runs on Introspection, and Acme behind it. */
type Behind = {
  chat: { from: string; text: string }[];
  exchanges: Exchange[];
  inbox: Email[];
  taskId?: string;
  conversations?: string;
  hosts?: Record<string, string>;
  busy: boolean;
  mission?: {
    s256: string;
    budget_cents: number;
    spent_cents: number;
    terminated?: string;
  };
};
type Snapshot = {
  step: "start" | "sign-in" | "talking" | "approve" | "disconnected";
  prompt?: string;
  busy: boolean;
  chat: ChatLine[];
  session?: {
    sid: string;
    signedIn: boolean;
    scopes: string[];
    conversation?: string;
  };
  behind: Behind;
  error?: string;
};

const PARTY: Parties = {
  "Flight Sector": { name: "Flight Sector", mark: "F" },
  Atlas: { name: "Atlas", mark: "A" },
  Tools: {
    name: "Tools",
    mark: "T",
    host: "travel-agent recipe, in its sandbox",
  },
  Acme: { name: "Acme", mark: "A" },
  "Booking provider": { name: "Booking provider", mark: "B" },
  Browserbase: { name: "Browserbase", mark: "W" },
};

/** What Sam might say next, once Flight Sector's agent has offered flights. */
const REPLIES = [
  "The one at no extra cost, please.",
  "QF8 via Dallas, even if it costs more.",
];

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
  flight: "Flight",
  from: "From",
  to: "To",
  date: "Date",
  depart: "Departs",
  arrive: "Arrives",
  total: "Fare",
  currency: "Currency",
  difference: "More than Sam paid",
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

export function PapDemo({ scenarios }: { scenarios: Scenario[] }) {
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
    useFollow(
      `${state?.chat.length}:${chatSize}:${state?.busy}`,
      state,
      picked,
    );

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
  const { behind, session } = state;
  const started = state.chat.length > 0;
  const working = sending || state.busy;
  const hint = scenarios.find(
    (s) => s.prompt === (state.prompt ?? prompt),
  )?.hint;
  const turns = [
    ...new Set([
      ...behind.exchanges.map((x) => x.turn),
      ...behind.inbox.map((e) => e.turn),
    ]),
  ].sort((a, b) => a - b);
  const shownTurn = picked ?? behind.exchanges.at(-1)?.turn;
  const details = behind.exchanges.filter((x) => x.turn === shownTurn);
  const lastAtlas = state.chat.findLastIndex((line) => line.from === "Atlas");
  const say = (text: string) => {
    if (!text.trim()) return;
    if (!started) setPicked(null);
    act({ action: "send", text });
    setPrompt("");
  };
  const decide: Decide = (email, verdict, budget) =>
    act({ action: "decide", email: email.index, verdict, budget });

  return (
    <div className="ademo pap">
      <Header
        brand={
          <>
            <span className="poppy-mark">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/atlas/poppy.png" alt="" width={22} height={22} />
              Poppy
            </span>
            <span className="step-label">
              draft 0.3 · in front of AAuth · on{" "}
              <span className="on-introspection">Introspection</span>
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
              href="https://github.com/introspection-recipes/recipe-travel-agent/blob/main/agents/poppy.yaml"
              target="_blank"
              rel="noopener noreferrer"
              className="control"
            >
              Recipe
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
        aside={
          <ConversationBar
            base={behind.conversations}
            taskId={behind.taskId}
            onLoad={(id) => {
              setPicked(null);
              act({ action: "join", taskId: id });
            }}
          />
        }
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
              onSend={() => say(prompt)}
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
            </Fragment>
          ))}
          {working && <div className="bubble agent working">…</div>}
          {state.step === "talking" && session?.signedIn && !working && (
            <div className="choices">
              {REPLIES.map((reply) => (
                <button
                  key={reply}
                  className="secondary"
                  onClick={() => say(reply)}
                >
                  {reply}
                </button>
              ))}
              <button
                className="secondary"
                onClick={() => act({ action: "disconnect" })}
              >
                Disconnect from Flight Sector
              </button>
            </div>
          )}
          {state.error && <div className="error">{state.error}</div>}
          {/* The chat's end: its gap keeps the last bubble off the composer. */}
          <div />
        </Phone>

        <BehindTheChat
          status={
            started
              ? working || behind.busy
                ? "In progress"
                : "Done"
              : "Ready"
          }
          intro={
            (!started || hint || session || behind.mission) && (
              <>
                {!started && (
                  <p>
                    Pick a sample or type your own. Atlas is Sam&apos;s own
                    agent, and Flight Sector has never seen it before: Atlas
                    finds it from its <code>poppy.json</code>, has Sam sign in
                    with plain OAuth, and talks to Flight Sector&apos;s agent,
                    the travel-agent recipe on Introspection, in a Session it
                    signs on every request. Behind it, the agent books over
                    AAuth, so Acme&apos;s Dana approves the trip and anything
                    over its budget.
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
                      : "signed out"}
                    {session.conversation && ` · ${session.conversation}`}
                  </div>
                )}{" "}
                {behind.mission && (
                  <div className="mission">
                    Mission <code>{behind.mission.s256.slice(0, 10)}…</code> ·
                    budget $
                    {Math.round(
                      behind.mission.budget_cents / 100,
                    ).toLocaleString("en-US")}{" "}
                    · spent $
                    {Math.round(
                      behind.mission.spent_cents / 100,
                    ).toLocaleString("en-US")}
                    {behind.mission.terminated &&
                      ` · ${behind.mission.terminated}`}
                  </div>
                )}
              </>
            )
          }
          paneRef={seenPane}
          onScroll={onSeenScroll}
        >
          {turns.map((turn) => (
            <Moment
              key={turn}
              title={
                <Markdown remarkPlugins={[remarkGfm]}>
                  {behind.chat[turn]?.text ?? "Working…"}
                </Markdown>
              }
              calls={behind.exchanges.filter((x) => x.turn === turn)}
              parties={PARTY}
              shown={turn === shownTurn}
              onShow={() => setPicked(turn)}
            >
              {behind.inbox
                .filter((e) => e.turn === turn)
                .map((email) => (
                  <Inbox
                    key={email.index}
                    email={email}
                    busy={sending}
                    onDecide={decide}
                  />
                ))}
            </Moment>
          ))}
        </BehindTheChat>

        <RequestDetails
          exchanges={details}
          parties={PARTY}
          hosts={behind.hosts}
          empty={
            <p>
              Each request Atlas sends Flight Sector appears here, with its
              Session header decoded, and behind it each call Flight
              Sector&apos;s agent makes through Introspection&apos;s egress,
              signed.
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
