"use client";

import { useEffect, useState } from "react";

/**
 * The run's conversation in Introspection, as an address bar: its URL to copy
 * or open, or another conversation's URL or id to paste and open.
 */
export function ConversationBar({
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
