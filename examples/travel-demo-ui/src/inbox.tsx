"use client";

import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** An email Acme's Person Server sent a person, with the code that proves they read it. */
export type Email = {
  index: number;
  turn: number;
  to: string;
  item: string;
  reasons: string[];
  code: string;
  budget: { suggested: number | null } | null;
  decided: boolean;
  /** Acme's answer: pending, approved or denied. */
  status?: string;
};

export type Decide = (
  email: Email,
  verdict: "approve" | "decline",
  budget?: number,
) => void;

/** A person's inbox, behind the chat: Acme's email, answered with its code. */
export function Inbox({
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
          {email.to} · Acme
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
