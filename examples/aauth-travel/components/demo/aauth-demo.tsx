"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
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
  StatusCard,
  useFollow,
} from "introspection-example-travel-demo-ui";

import { recipe } from "@/flow/recipe.mjs";

import { AAuthLogo, IntrospectionMark } from "./aauth-logo";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
const PARTY: Parties = {
  Tools: {
    name: "Tools",
    mark: "T",
    host: "travel-agent recipe, in its sandbox",
  },
  Acme: { name: "Acme", mark: "A" },
  "Booking provider": { name: "Booking provider", mark: "B" },
  Browserbase: { name: "Browserbase", mark: "W" },
};

/**
 * Sam's side of a decision Dana makes at Acme, in his phone: where it stands,
 * with nothing to press. Dana answers in her own inbox, behind the chat.
 */
function Waits({ emails }: { emails: Email[] }) {
  return emails
    .filter((email) => !email.to.startsWith("Sam"))
    .map((email) => {
      const what = email.budget
        ? "the trip and its budget"
        : "a booking over what is left of the budget";
      const [title, tone] =
        email.status === "approved"
          ? ["Approved: booking now", "ok" as const]
          : email.status === "denied"
            ? [`${email.to} declined ${what}`, "no" as const]
            : [
                `Waiting on ${email.to} at Acme to approve ${what}`,
                "wait" as const,
              ];
      return (
        <StatusCard
          key={email.index}
          who={`${email.to} · Acme`}
          title={title}
          detail={email.reasons[0]}
          tone={tone}
          className="mail-dana"
        />
      );
    });
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

export function AAuthDemo({ scenarios }: { scenarios: Scenario[] }) {
  const [state, setState] = useState<Snapshot | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
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
  const { chatBox, seenPane, detailsPane, onSeenScroll, onDetailsScroll } =
    useFollow(`${chatCount}:${chatSize}:${state?.working}`, state, picked);

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
      <Header
        brand={
          <>
            <AAuthLogo />
            <span className="step-label">
              -11 · three-party, with a mission · on{" "}
              <span className="on-introspection">
                <IntrospectionMark />
                Introspection
              </span>
            </span>
          </>
        }
        controls={
          <>
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
          </>
        }
        title={<>Flight Sector&apos;s agent books Sam&apos;s trip for Acme</>}
        aside={
          <ConversationBar
            base={state?.conversations}
            taskId={state?.taskId}
            onLoad={(id) => {
              setPicked(null);
              act({ action: "join", taskId: id });
            }}
          />
        }
      />

      <div className="stage">
        <Phone
          avatar="F"
          name="Flight Sector"
          subtitle="Acme's travel agent"
          chatRef={chatBox}
          composer={
            <Composer
              value={prompt}
              onChange={setPrompt}
              onSend={send}
              placeholder={
                started ? "Reply as Sam" : "Message Flight Sector as Sam"
              }
              label="Sam's message"
              busy={sending}
              working={state.working}
              onStop={() => act({ action: "stop" })}
            />
          }
        >
          {!started && (
            <Ideas prompts={scenarios} value={prompt} onPick={setPrompt} />
          )}
          {state.chat.map((line, i) => {
            const waits = (
              <Waits emails={state.inbox.filter((e) => e.turn === i)} />
            );
            // Under the agent's reply that follows them, or ahead of Sam's.
            const why = (
              <Why
                errors={(state.toolErrors ?? []).filter((e) => e.turn === i)}
              />
            );
            return (
              <Fragment key={i}>
                {line.from === "Sam" && why}
                <div
                  className={`bubble ${line.from === "Sam" ? "sam" : "agent"}`}
                >
                  {line.from === "Agent" ? (
                    <Markdown remarkPlugins={[remarkGfm]}>{line.text}</Markdown>
                  ) : (
                    line.text
                  )}
                </div>
                {line.from === "Agent" && why}
                {waits}
              </Fragment>
            );
          })}
          <Waits
            emails={state.inbox.filter((e) => e.turn >= state.chat.length)}
          />
          <Why
            errors={(state.toolErrors ?? []).filter(
              (e) => e.turn >= state.chat.length,
            )}
          />
          {state.working && !waitingOn && (
            <div className="bubble agent working">…</div>
          )}
          {state.error && <div className="error">{state.error}</div>}
          {/* The chat's end: its gap keeps the last bubble off the composer. */}
          <div />
        </Phone>

        <BehindTheChat
          status={started ? (state.busy ? "In progress" : "Done") : "Ready"}
          intro={
            (!started || hint || state.mission) && (
              <>
                {!started && (
                  <p>
                    Pick a sample or type your own: where, when, cabin, hotel
                    and a budget. Flight Sector&apos;s travel-agent recipe runs
                    on Introspection: its egress signs every call and runs
                    Flight Sector&apos;s Cedar rails before Acme is asked, and
                    Acme&apos;s Person Server speaks for Sam, so Dana approves
                    the trip once and anything over its budget.
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
                    {Math.round(
                      state.mission.budget_cents / 100,
                    ).toLocaleString("en-US")}{" "}
                    · spent $
                    {Math.round(state.mission.spent_cents / 100).toLocaleString(
                      "en-US",
                    )}
                    {state.mission.terminated &&
                      ` · ${state.mission.terminated}`}
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
                  {state.chat[turn]?.text ?? "Working…"}
                </Markdown>
              }
              calls={state.exchanges.filter((x) => x.turn === turn)}
              parties={PARTY}
              shown={turn === shownTurn}
              onShow={() => setPicked(turn)}
            >
              {state.inbox
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
          hosts={state.hosts}
          empty={
            <p>
              Each request Introspection&apos;s egress sends for the agent
              appears here, as it arrived, signed.
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
