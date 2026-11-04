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
        <>
          <div className="sees-head">
            <span className="mark">{parties[called[0]]?.mark ?? "?"}</span>
            {called.map((p) => parties[p]?.name ?? p).join(" · ")}
          </div>
          <div className="sees-box">
            {calls.map((x) => (
              <div key={x.id} className="seen">
                <span className="seen-who">{parties[x.to]?.name ?? x.to}</span>
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
