/**
 * NOT THE DEMO. A stand-in for the Company Agent, for `pnpm e2e` only
 * (POPPY_AGENT=stub): it answers at the bridge boundary with fixed lines and
 * one `request_approval` call, so the Poppy protocol between a Personal Agent
 * and Flight Sector's endpoints can be tested with no Introspection backend.
 * No model, recipe, mission or approval at Acme runs here. The demo's Company
 * Agent is the travel-agent recipe on Introspection (driver.ts).
 */
import "server-only";

import { once } from "../once";
import type { AgentDriver, AgentState } from "./driver";

const TERMS = {
  flight: "QF8",
  from: "SFO",
  to: "SYD",
  date: "2026-10-18",
  total: "2050.00",
  currency: "USD",
  difference: "400.00",
};

const state = once("stub_agent", () => ({
  current: {
    lines: [],
    calls: [],
    busy: false,
    streaming: false,
  } as AgentState,
}));

function reply(prompt: string) {
  const s = state.current;
  const line = (text: string) =>
    s.lines.push({ from: "Agent", text, done: true });
  if (/\[platform\][^\n]*approved/i.test(prompt))
    return line("Booked: QF8 via Dallas, landing 06:15 on the 20th.");
  if (/QF8|Dallas/i.test(prompt)) {
    s.calls.push({
      id: `call_${s.calls.length + 1}`,
      name: "request_approval",
      args: JSON.stringify({
        summary:
          "Rebook FS-8Q2M from QF74 to QF8 via Dallas on 18 Oct, landing 06:15 on the 20th, for $2,050.00: $400.00 more than the ticket it replaces.",
        terms: TERMS,
      }),
      turn: s.lines.length,
    });
    return line(
      "QF8 costs $400 more; I'll book it once the traveller approves.",
    );
  }
  if (/UA863|no extra/i.test(prompt))
    return line("Booked: UA863, landing 08:00 on the 20th, at no extra cost.");
  line(
    "UA863 lands at 08:00 at no extra cost, or QF8 via Dallas lands at 06:15 for $400 more. Which would they like?",
  );
}

export const stubAgent: AgentDriver = {
  async start(prompt, shown) {
    state.current = { lines: [], calls: [], busy: false, streaming: false };
    state.current.taskId = "stub-task";
    state.current.lines.push({ from: "Atlas", text: shown });
    reply(prompt);
  },
  async send(prompt, shown) {
    state.current.lines.push({ from: "Atlas", text: shown });
    reply(prompt);
    return true;
  },
  state: () => state.current,
};
