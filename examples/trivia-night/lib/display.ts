import { GENRES } from "./question-types";

/** Text helpers for the evals panel: the target's label and the facts in a venue's notes. */

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
