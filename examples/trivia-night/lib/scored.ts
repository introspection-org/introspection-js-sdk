/** A trial counts in the analysis only when it ran: one that errored measured nothing. */
export const scored = (trial: { error?: unknown } | null | undefined) =>
  Boolean(trial) && !trial?.error;
