"use client";

import { type ReactNode, type RefObject, useEffect, useRef } from "react";

import { type Exchange, type Parties, tone } from "./wire";

/** The traveller's phone: a chat with one party, and a composer under it. */
export function Phone(props: {
  avatar: string;
  name: string;
  subtitle: string;
  chatRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
  composer: ReactNode;
}) {
  const { avatar, name, subtitle, chatRef, children, composer } = props;
  return (
    <div className="phone">
      <div className="phone-screen">
        <div className="phone-status" aria-hidden>
          <span>9:41</span>
          <span>5G</span>
        </div>
        <div className="phone-head">
          <span className="avatar">{avatar}</span>
          <div>
            <strong>{name}</strong>
            <span>{subtitle}</span>
          </div>
        </div>
        <div className="phone-chat" ref={chatRef}>
          {children}
        </div>
        {composer}
      </div>
    </div>
  );
}

/** A chat app's input: it grows with its text, and Enter sends. */
export function Composer(props: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder: string;
  label: string;
  /** A request from the page is in flight. */
  busy: boolean;
  /** The other side is working: Enter waits, and the button stops it. */
  working?: boolean;
  onStop?: () => void;
}) {
  const { value, onChange, onSend, placeholder, label, busy } = props;
  const { working, onStop } = props;
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    // scrollHeight leaves out the borders; without them the box is a little
    // short of its text and shows a scrollbar for a single line.
    const borders = el.offsetHeight - el.clientHeight;
    if (value) el.style.height = `${el.scrollHeight + borders}px`;
    el.style.overflowY =
      el.scrollHeight + borders > parseFloat(getComputedStyle(el).maxHeight)
        ? "auto"
        : "hidden";
  }, [value]);
  return (
    <div className="phone-composer">
      <textarea
        ref={box}
        rows={1}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!working) onSend();
          }
        }}
        aria-label={label}
      />
      {working && onStop ? (
        <button onClick={onStop} disabled={busy} aria-label="Stop">
          ■
        </button>
      ) : (
        <button
          onClick={onSend}
          disabled={busy || !value.trim()}
          aria-label="Send"
        >
          ↑
        </button>
      )}
    </div>
  );
}

/** A row in a box of what a party sees: who, what, and an optional pill. */
export type SeenRow = {
  key: string | number;
  who: string;
  what: ReactNode;
  pill?: { label: ReactNode; tone: string };
};

/** A party's mark and name over the rows of what it sees. */
export function Sees(props: { mark: string; title: string; rows: SeenRow[] }) {
  const { mark, title, rows } = props;
  return (
    <>
      <div className="sees-head">
        <span className="mark">{mark}</span>
        {title}
      </div>
      <div className="sees-box">
        {rows.map((row) => (
          <div key={row.key} className="seen">
            <span className="seen-who">{row.who}</span>
            <span>{row.what}</span>
            {row.pill && (
              <span className={`pill ${row.pill.tone}`}>{row.pill.label}</span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/** One turn of the chat, behind it: who was called, and anything a person must answer. */
export function Moment(props: {
  title: ReactNode;
  calls: Exchange[];
  parties: Parties;
  shown: boolean;
  onShow: () => void;
  children?: ReactNode;
}) {
  const { title, calls, parties, shown, onShow, children } = props;
  const called = [...new Set(calls.map((x) => x.to))];
  return (
    <section className={`moment ${shown ? "moment-shown" : ""}`}>
      <div className="moment-title">{title}</div>
      {called.length > 0 && (
        <Sees
          mark={parties[called[0]]?.mark ?? "?"}
          title={called.map((p) => parties[p]?.name ?? p).join(" · ")}
          rows={calls.map((x) => ({
            key: x.id,
            who: parties[x.to]?.name ?? x.to,
            what: (
              <>
                {x.label}
                {x.repeats > 1 && ` ×${x.repeats}`}
              </>
            ),
            pill: { label: x.status, tone: tone(x.status) },
          }))}
        />
      )}
      {children}
      {calls.length > 0 && (
        <button className="details-toggle" onClick={onShow}>
          <span className="braces">{"{ }"}</span>{" "}
          {shown ? "Showing request details →" : "Show request details"}
        </button>
      )}
    </section>
  );
}

/** The page's header: the protocol's mark and line, its links, and the title. */
export function Header(props: {
  brand: ReactNode;
  controls: ReactNode;
  title: ReactNode;
  /** Beside the title, such as aauth-travel's conversation bar. */
  aside?: ReactNode;
}) {
  const { brand, controls, title, aside } = props;
  return (
    <header className="ademo-head">
      <div className="ademo-row">
        <div className="brand">{brand}</div>
        <div className="ademo-controls">{controls}</div>
      </div>
      <div className="ademo-title">
        <h1>{title}</h1>
        {aside}
      </div>
    </header>
  );
}

/** Sample prompts on an empty chat, each under a caption of what it shows. */
export function Ideas(props: {
  prompts: { id: string; title: string; prompt: string }[];
  value: string;
  onPick: (prompt: string) => void;
}) {
  const { prompts, value, onPick } = props;
  return (
    <div className="ideas">
      <span className="muted">Try asking for…</span>
      {prompts.map((s) => (
        <button
          key={s.id}
          className={`idea ${s.prompt === value ? "idea-on" : ""}`}
          onClick={() => onPick(s.prompt)}
        >
          <span className="idea-title">{s.title}</span>
          {s.prompt}
        </button>
      ))}
    </div>
  );
}

/** The middle pane: its status, an intro, and a moment per turn of the chat. */
export function BehindTheChat(props: {
  status: string;
  intro?: ReactNode;
  paneRef: RefObject<HTMLDivElement | null>;
  onScroll: (pane: HTMLDivElement) => void;
  children: ReactNode;
}) {
  const { status, intro, paneRef, onScroll, children } = props;
  return (
    <div className="pane">
      <div className="pane-head">
        <div className="step-label">Behind the chat</div>
        <span className="pane-status">{status}</span>
      </div>
      {intro && <div className="pane-intro">{intro}</div>}
      <div
        className="pane-body"
        ref={paneRef}
        onScroll={(e) => onScroll(e.currentTarget)}
      >
        {children}
      </div>
    </div>
  );
}
