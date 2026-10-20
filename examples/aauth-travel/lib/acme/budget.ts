/**
 * A trip's budget, as Acme's approval page offers it. A mission records only a
 * budget, not the bookings the approver saw, so the page starts at the quoted
 * total of the trip as proposed: approving it as offered covers every booking
 * listed, and only something else, or a lower budget, comes back.
 */

export const dollars = (cents: number) =>
  `$${Math.round(cents / 100).toLocaleString("en-US")}`;

const cents = (pattern: RegExp, description: string): number | null => {
  const match = pattern.exec(description);
  return match ? Number(match[1]!.replace(/,/g, "")) * 100 : null;
};

/** What the approver is offered for a trip: the quoted total and the agent's suggestion, each when the proposal names one. */
export function tripBudget(description: string) {
  return {
    quoted_cents: cents(/quoted total:?\s*\$([\d,]+)/i, description),
    suggested_cents: cents(/up to \$([\d,]+)/i, description),
  };
}

/** Why a trip is in front of the approver, and what its budget will mean. */
export function tripReasons(traveller: string, description: string): string[] {
  const { quoted_cents, suggested_cents } = tripBudget(description);
  return [
    `A trip for ${traveller}: you set its budget`,
    quoted_cents === null
      ? suggested_cents === null
        ? "The agent suggested no budget"
        : `The agent suggested up to ${dollars(suggested_cents)}`
      : `The trip as proposed comes to ${dollars(quoted_cents)}${suggested_cents === null ? "" : `; the agent suggested up to ${dollars(suggested_cents)}`}`,
    "A booking over the budget you set comes back to you",
  ];
}
