import { GENRES } from "./question-types";

/** Text helpers for the evals panel: markdown to one plain line, and short labels. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One line of markdown as plain text: no list marker, heading #s, emphasis or backticks. */
export function plainLine(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Markdown as plain text on one line. */
export function plainText(markdown: string): string {
  return markdown.split("\n").map(plainLine).filter(Boolean).join(" ");
}

/** The text cut at a word boundary to at most `max` characters, with "…" when cut. */
export function truncateWords(text: string, max: number): string {
  if (text.length <= max) return text;
  // One character past the budget, so a word that ends exactly at it is kept.
  const space = text.slice(0, max).lastIndexOf(" ");
  const head = space > max / 2 ? text.slice(0, space) : text.slice(0, max - 1);
  return `${head.replace(/[\s,;:.·-]+$/, "")}…`;
}

/** The first line of the notes that says something, as plain text: not blank, not a heading. */
export function notesPreview(notes: string, max = 70): string | null {
  const line = notes
    .split("\n")
    .filter((item) => !item.trim().startsWith("#"))
    .map(plainLine)
    .find(Boolean);
  return line ? truncateWords(line, max) : null;
}

const KIND_LABELS: Record<string, string> = {
  "bank.served": "tool",
  "bank.marked": "tool",
  "memory.read": "read",
  "memory.written": "write",
  "host.planned": "plan",
};

/** A short pill label for an event type. */
export function kindLabel(type: string): string {
  return KIND_LABELS[type] ?? type.split(".").pop()!;
}

/** An MCP tool call as `trivia-bank · next_questions · music · difficulty 3 · uk · 8 questions`. */
export function toolLine(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  const parts = [server, tool];
  if (args.genre !== undefined) parts.push(String(args.genre));
  if (args.difficulty !== undefined)
    parts.push(`difficulty ${String(args.difficulty)}`);
  if (args.region !== undefined) parts.push(String(args.region));
  if (typeof args.count === "number") parts.push(`${args.count} questions`);
  if (Array.isArray(args.answers)) parts.push(`${args.answers.length} answers`);
  if (Array.isArray(args.names)) parts.push(`${args.names.length} teams`);
  return parts.join(" · ");
}

/** The eval target as `trivia-host @ e328209`: its slug, else the runtime id cut to 8 characters. */
export function targetLabel(
  runtime: string,
  commit: string,
  slug?: string,
): string {
  const name = slug || (UUID.test(runtime) ? runtime.slice(0, 8) : runtime);
  return `${name} @ ${commit.slice(0, 7)}`;
}

/** A fact the cell shows from a venue's notes; `changed` when it differs from night 1. */
export interface FactChip {
  key: "region" | "difficulty" | "genres";
  text: string;
  changed: boolean;
}

type Facts = Partial<Record<FactChip["key"], string>>;

/** The genres a line names, in the order it names them. */
function genreList(text: string): string {
  const found = [
    ...text
      .toLowerCase()
      .matchAll(new RegExp(`\\b(${GENRES.join("|")})s?\\b`, "g")),
  ].map((match) => match[1]);
  return [...new Set(found)].slice(0, 3).join(", ");
}

function parseFacts(notes: string): Facts {
  const facts: Facts = {};
  for (const raw of notes.split("\n")) {
    const line = plainLine(raw);
    const colon = line.indexOf(":");
    if (colon < 1 || colon > 40) continue;
    const label = line.slice(0, colon).toLowerCase();
    const rest = line.slice(colon + 1).trim();
    if (!facts.region && /country|region|location/.test(label)) {
      const value = rest.split(/[(.,;]/)[0].trim();
      if (value && value.length <= 20) facts.region = value;
    } else if (!facts.difficulty && label.includes("difficulty")) {
      const value = /\d+/.exec(rest)?.[0];
      if (value) facts.difficulty = value;
    } else if (!facts.genres && /genre|liked|played/.test(label)) {
      const value = genreList(rest);
      if (value) facts.genres = value;
    }
  }
  return facts;
}

/**
 * Up to three chips from a venue's notes: country, starting difficulty and
 * genres. With `previous` (the night 1 notes), a fact that changed shows
 * `before→after`. Empty when nothing parses.
 */
export function factChips(notes: string, previous?: string): FactChip[] {
  const now = parseFacts(notes);
  const before = previous ? parseFacts(previous) : {};
  const chips: FactChip[] = [];
  const add = (key: FactChip["key"], show: (value: string) => string) => {
    const value = now[key];
    if (!value) return;
    const was = before[key];
    const changed = Boolean(was && was !== value);
    chips.push({
      key,
      text: changed && key !== "genres" ? show(`${was}→${value}`) : show(value),
      changed,
    });
  };
  add("region", (value) => value);
  add("difficulty", (value) => `diff ${value}`);
  add("genres", (value) => `played: ${value}`);
  return chips;
}

/** The starting difficulty a venue's notes set, or null when they name none. */
export function startingDifficulty(notes: string): number | null {
  const value = parseFacts(notes).difficulty;
  return value ? Number(value) : null;
}

/** The first sentence or two of a message, as plain text, cut to `max` characters. */
export function firstSentences(text: string, count = 2, max = 200): string {
  const plain = plainText(text);
  const sentences = plain.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [plain];
  return truncateWords(sentences.slice(0, count).join("").trim(), max);
}

/** A fetched round as `history · uk · diff 3`. */
export function roundLabel(round: {
  genre?: string;
  region?: string;
  difficulty?: number;
}): string {
  return [
    round.genre,
    round.region,
    typeof round.difficulty === "number" ? `diff ${round.difficulty}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
