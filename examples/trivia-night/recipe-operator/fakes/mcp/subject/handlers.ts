// The trivia master's voice: a fixed script from the venue's profile and the
// conversation's state, never a free model. It sees only what the host says.
import {
  type McpServer,
  text,
  toolsOf,
} from "@introspection-ai/eval-simulate/mcp";
import type { Genre } from "../trivia-bank/entities.ts";
import { byId, enjoyment, GENRES, type Profile } from "../../world/profiles.ts";
import { contract } from "./contract.ts";
import type { SubjectState } from "./entities.ts";

const { config, answer } = toolsOf(contract);
export const ROUNDS_TONIGHT = 3;
const COUNTRY = { au: "Australia", uk: "the UK", us: "the US" } as const;

const list = (xs: string[]) =>
  xs.length < 2
    ? xs.join("")
    : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

export function opening(p: Profile, night: number): string {
  const teams = `Teams: ${p.teams.join(", ")}.`;
  const request =
    p.request.night === night
      ? ` It's ${p.request.who}'s birthday and they're mad about ${p.request.genre}, so can we do all ${p.request.genre} tonight?`
      : "";
  if (night === 1)
    return `Hi! First quiz night with you here at ${p.pub} in ${p.city}. Three rounds tonight, we've got a band on at nine. The regulars reckon they're big on ${list(p.stated)}. ${teams}${request}`;
  return `Evening! Three rounds again tonight, band's on at nine. ${teams}${request}`;
}

/** A message that sets a round: at least three numbered questions, one per line or run together on one line. */
export function questionCount(message: string): number {
  const perLine = message
    .split("\n")
    .filter(
      (l) =>
        /^\s*(\*\*)?(Q(uestion)?\s*)?\d{1,2}(\*\*)?[.):]/i.test(l) &&
        l.includes("?"),
    ).length;
  const inline = (
    message.match(
      /(?:^|\s)(?:\*\*)?(?:Q(?:uestion)?\s*)?\d{1,2}(?:\*\*)?[.):]\s[^?\n]{3,}\?/gi,
    ) ?? []
  ).length;
  return Math.max(perLine, inline);
}

export function roundGenre(message: string): Genre | null {
  const counts = GENRES.map(
    (g) =>
      [
        g,
        (message.toLowerCase().match(new RegExp(`\\b${g}\\b`, "g")) ?? [])
          .length,
      ] as const,
  );
  const [genre, n] = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return n > 0 ? genre : null;
}

export function remark(e: number, genre: Genre | null): string {
  const g = genre ?? "that";
  if (e >= 0.75) return `The room loved that ${g} round, big cheers!`;
  if (e >= 0.55) return `That ${g} round went down fine.`;
  if (e > 0.35) return `Bit flat in here for ${g}.`;
  return `Groans all round for ${g}, not really this crowd's thing.`;
}

// Each team's written answer is a token: in this world the bank marks it from the venue's profile.
export function sheet(
  p: Profile,
  _night: number,
  _round: number,
  count: number,
): string {
  return p.teams
    .map(
      (team, t) =>
        `${team}: ${Array.from({ length: count }, (_, i) => `${i + 1} sheet-${String.fromCharCode(97 + t)}${i + 1}`).join(", ")}`,
    )
    .join("\n");
}

export function register(server: McpServer, state: SubjectState) {
  server.registerTool("say", config("say"), async ({ text: message }) => {
    const p = state.venue ? byId(state.venue) : undefined;
    if (!p) return text("No venue is set in this world.", true);
    const c = state.conversation;
    if (message.trim() === "") {
      if (c.phase === "open" || c.phase === "last-round-in")
        return answer("say", "(The trivia master is waiting for you.)");
      c.night += 1;
      c.phase = "open";
      c.roundsTonight = 0;
      return answer("say", p.openings?.[c.night] ?? opening(p, c.night));
    }
    if (c.phase === "ended" || c.phase === "closed")
      return answer(
        "say",
        "[The trivia master has gone home. The night is over: finish what you do at the end of a night, then stop.]",
      );
    const count = questionCount(message);
    if (count >= 3 && c.phase === "open") {
      c.roundsTonight += 1;
      const genre = roundGenre(message);
      const e = genre ? enjoyment(p, genre, c.night) : 0.5;
      const last = c.roundsTonight >= (p.rounds ?? ROUNDS_TONIGHT);
      if (last) c.phase = "last-round-in";
      return answer(
        "say",
        `${remark(e, genre)} Here's the sheet for that round:\n${sheet(p, c.night, c.roundsTonight, count)}${last ? "\nThat's our last round tonight." : ""}`,
      );
    }
    if (c.phase === "last-round-in") {
      c.phase = "ended";
      return answer(
        "say",
        "Brilliant night, thanks! See you next week. [The night is over.]",
      );
    }
    if (/countr|where are you|which city/i.test(message))
      return answer("say", `We're in ${p.city}, ${COUNTRY[p.region]}.`);
    if (/team/i.test(message) && /\?/.test(message))
      return answer("say", `Teams tonight: ${p.teams.join(", ")}.`);
    return answer("say", "Sounds good, go ahead.");
  });
}
