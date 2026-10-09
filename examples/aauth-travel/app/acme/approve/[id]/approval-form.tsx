"use client";

import { useRef, useState } from "react";

const DIGITS = 6;

export function ApprovalForm({
  decisionUrl,
  sentTo,
  initialStatus,
}: {
  decisionUrl: string;
  sentTo: string;
  initialStatus: string;
}) {
  const [digits, setDigits] = useState<string[]>(Array(DIGITS).fill(""));
  const [status, setStatus] = useState(initialStatus);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const code = digits.join("");

  function fill(from: number, typed: string) {
    let cleaned = typed.replace(/\D/g, "");
    // Typing over a filled box gives two characters; keep the new one.
    if (digits[from] && cleaned.length === 2)
      cleaned = cleaned.startsWith(digits[from])
        ? cleaned.slice(1)
        : cleaned.slice(0, 1);
    const incoming = cleaned.slice(0, DIGITS - from).split("");
    if (incoming.length === 0) {
      const next = [...digits];
      next[from] = "";
      setDigits(next);
      return;
    }
    const next = [...digits];
    incoming.forEach((digit, offset) => (next[from + offset] = digit));
    setDigits(next);
    setError("");
    boxes.current[Math.min(from + incoming.length, DIGITS - 1)]?.focus();
  }

  async function submit(verdict: "approve" | "decline") {
    setBusy(true);
    setError("");
    const response = await fetch(decisionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, verdict }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (response.ok) setStatus(body.status);
    else setError(body.detail ?? "Something went wrong. Try again.");
  }

  if (status === "approved")
    return (
      <p className="acme-done">Approved. Flight Sector will book it now.</p>
    );
  if (status === "denied")
    return <p className="acme-done">Declined. The traveller will be told.</p>;

  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <p>Enter the six-digit code we emailed to {sentTo}.</p>
      <div className="acme-code">
        {digits.map((digit, index) => (
          <input
            key={index}
            ref={(element) => {
              boxes.current[index] = element;
            }}
            value={digit}
            inputMode="numeric"
            autoComplete={index === 0 ? "one-time-code" : "off"}
            aria-label={`Digit ${index + 1}`}
            onChange={(event) => fill(index, event.target.value)}
            onPaste={(event) => {
              event.preventDefault();
              fill(index, event.clipboardData.getData("text"));
            }}
            onKeyDown={(event) => {
              if (event.key === "Backspace" && !digit && index > 0) {
                const next = [...digits];
                next[index - 1] = "";
                setDigits(next);
                boxes.current[index - 1]?.focus();
              }
            }}
          />
        ))}
      </div>
      <p className="acme-error" role="alert">
        {error}
      </p>
      <div className="acme-actions">
        <button
          type="button"
          disabled={busy || code.length < DIGITS}
          onClick={() => submit("decline")}
        >
          Decline
        </button>
        <button
          type="button"
          className="approve"
          disabled={busy || code.length < DIGITS}
          onClick={() => submit("approve")}
        >
          Approve
        </button>
      </div>
    </form>
  );
}
