"use client";

import { Fragment, type ReactNode, type RefObject, useState } from "react";

/** One request a party sent, as the page shows it, under the chat line `turn`. */
export type Exchange = {
  id: number | string;
  from: string;
  to: string;
  label: string;
  request: string;
  response: string;
  status: number;
  /** How many identical requests this row stands for. */
  repeats: number;
  turn: number;
};

/** How the page names each party a request goes to. */
export type Parties = Record<
  string,
  { name: string; mark: string; host?: string }
>;

const TOKEN =
  /("(?:[^"\\]|\\.)*")(\s*:)?|\b(-?\d+(?:\.\d+)?)\b|^(GET|POST|PUT|PATCH|DELETE|HTTP\/1\.1)\b|^([A-Za-z-]+)(?=: )|^(cedar is_authorized|decision: \w+)/gm;

/** The colouring the PAP site gives its exchanges: methods, headers, keys, strings, numbers. */
export function highlight(text: string): ReactNode {
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

/** The pill colour for a response status. */
export function tone(status: number) {
  if (status >= 200 && status < 300) return status === 202 ? "wait" : "ok";
  if (status === 401) return "ask";
  return "no";
}

/** Copies a request and its response, as shown, and says so for a moment. */
export function CopyButton({ text }: { text: string }) {
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

/** The right-hand pane: each request of the turn shown, as it went, with its response. */
export function RequestDetails(props: {
  exchanges: Exchange[];
  parties: Parties;
  /** Hosts to show for a party in place of its `host`. */
  hosts?: Record<string, string>;
  /** Shown while there is nothing to show. */
  empty: ReactNode;
  /** Set while the reader has picked a turn, to go back to following the latest. */
  onFollow?: () => void;
  paneRef: RefObject<HTMLDivElement | null>;
  onScroll: (pane: HTMLDivElement) => void;
}) {
  const { exchanges, parties, hosts, empty, onFollow, paneRef, onScroll } =
    props;
  return (
    <div className="pane details">
      <div className="pane-head">
        <div className="step-label">
          <span className="braces">{"{ }"}</span> Request details
        </div>
        {onFollow && (
          <button className="follow" onClick={onFollow}>
            Follow the latest
          </button>
        )}
      </div>
      {exchanges.length === 0 && <div className="pane-intro">{empty}</div>}
      <div
        className="pane-body"
        ref={paneRef}
        onScroll={(e) => onScroll(e.currentTarget)}
      >
        {exchanges.map((x) => (
          <div key={x.id} className="exchange">
            <div className="exchange-head">
              <span className="dir">
                {x.from} ↔ {hosts?.[x.to] ?? parties[x.to]?.host ?? x.to}
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
  );
}
