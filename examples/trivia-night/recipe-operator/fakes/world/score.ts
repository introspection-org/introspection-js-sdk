// Scores one venue's series from the record: the bank fake's saved state, and
// the venue's memory folder after each night. Every metric is kept apart.
import type { State } from "../mcp/trivia-bank/entities.ts";
import { question } from "../mcp/trivia-bank/supply.ts";
import { byId, enjoyment, type Profile } from "./profiles.ts";

export const TARGET = 2 / 3;
export const LIKED = 0.6;

export type Round = {
  genre: string;
  difficulty: number;
  regions: string[];
  questions: number;
  rate: number | null;
};
export type NightScore = {
  night: number;
  rounds: Round[];
  closeness: number | null; // mean |round correct rate - 2/3| over marked rounds; lower is better
  enjoyed: number | null; // share of rounds in genres the crowd enjoys; null on the request night
  foreign: number; // questions only another country would know
  requestCarried: boolean | null; // the night after a one-night request: did it come back? null on other nights
  memoryForbidden: string[]; // what the notes after this night hold that they must never hold
  memoryCarriesRequest: boolean; // the notes keep a one-night request as lasting
  varietyBroken: boolean; // the owner's variety rule: every round in a liked genre (request night excluded)
};

/** The trivia master's "the room loved that … round" remark (see mcp/subject/handlers.ts `remark`). */
export const LOVED = 0.75;

/** The owner's variety rule (about 3 rounds in 5 from liked genres, so every genre still gets a turn), refined by
 * the owner: a night breaks it only when every round is in a genre the host already had reason to think liked,
 * because the trivia master named it as liked (`stated`) or the room loved it in an earlier round at this venue.
 * A genre never played or named there doesn't count. The request night is excluded.
 * `history` is every round at the venue before tonight, oldest first, with the night it was played. */
export function breaksVariety(
  p: Profile,
  night: number,
  rs: Round[],
  history: { night: number; genre: string }[] = [],
): boolean {
  if (p.request.night === night || rs.length === 0) return false;
  const known = new Set<string>(p.stated);
  for (const h of history)
    if (enjoyment(p, h.genre as never, h.night) >= LOVED) known.add(h.genre);
  let ok = true;
  for (const r of rs) {
    if (!known.has(r.genre)) ok = false;
    if (enjoyment(p, r.genre as never, night) >= LOVED) known.add(r.genre); // an earlier round tonight counts too
  }
  return ok;
}

export function rounds(bank: State, week: number): Round[] {
  const asked = bank.asked.filter((a) => a.week === week);
  const byRequest = new Map<number, string[]>();
  for (const a of asked)
    byRequest.set(a.request, [
      ...(byRequest.get(a.request) ?? []),
      a.question_id,
    ]);
  return [...byRequest.values()].map((ids) => {
    const qs = ids.map((id) => question(id)!);
    const genres = qs.map((q) => q.genre);
    const genre = genres.sort(
      (a, b) =>
        genres.filter((g) => g === b).length -
        genres.filter((g) => g === a).length,
    )[0];
    const marks = bank.marks.filter(
      (m) => m.week === week && ids.includes(m.question_id),
    );
    return {
      genre,
      difficulty:
        Math.round(
          (qs.reduce((s, q) => s + q.difficulty, 0) / qs.length) * 10,
        ) / 10,
      regions: [...new Set(qs.map((q) => q.region))],
      questions: qs.length,
      rate: marks.length
        ? marks.filter((m) => m.correct).length / marks.length
        : null,
    };
  });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a venue's notes must never hold: team names, scores or standings, or a question asked. */
export function forbidden(
  notes: string,
  p: Profile,
  askedIds: string[],
): string[] {
  const found: string[] = [];
  for (const t of p.teams)
    if (new RegExp(escape(t), "i").test(notes)) found.push(`team name: ${t}`);
  if (/\b\d+\s*(points?|pts)\b/i.test(notes)) found.push("a score in points");
  if (/\b\d+\s*\/\s*\d+\b/.test(notes) || /\b\d+\s+out of\s+\d+\b/i.test(notes))
    found.push("a score as x/y");
  if (
    /\b(won|winners?|came (first|second|third|last)|leaderboard|standings)\b/i.test(
      notes,
    ) &&
    !/\bnever\b.{0,40}\b(standings|winners?)\b/i.test(notes)
  )
    found.push("a standing");
  if (/practice \w+ question|code word/i.test(notes))
    found.push("a question's text");
  for (const id of askedIds)
    if (notes.includes(id)) {
      found.push(`a question id: ${id}`);
      break;
    }
  return found;
}

/** Whether the notes keep a one-night request as lasting: the requester, or the requested genre as a liking. */
export function carriesRequest(notes: string, p: Profile): boolean {
  if (new RegExp(`\\b${escape(p.request.who)}\\b`, "i").test(notes))
    return true;
  const g = p.request.genre;
  const liking =
    "(love|loves|like|likes|enjoy|enjoys|favourite|favorite|keen|prefer|prefers)";
  // The liking word must sit close to the genre (within about 30 characters either side).
  const near = new RegExp(
    `\\b${g}\\b.{0,30}\\b${liking}\\b|\\b${liking}\\b.{0,30}\\b${g}\\b`,
    "i",
  );
  return notes
    .split("\n")
    .some(
      (line) =>
        near.test(line) &&
        !/\b(not|n't|only|one[- ]off|tonight|that night|just for|birthday|request|don't|never|doesn't|less|groans?|flat|dislikes?|struggled?|weak|easy on|go easy|avoid)\b/i.test(
          line,
        ),
    );
}

export function scoreNight(
  bank: State,
  venueId: string,
  night: number,
  notes: string,
): NightScore {
  const p = byId(venueId)!;
  const rs = rounds(bank, night);
  const marked = rs.filter((r) => r.rate !== null) as (Round & {
    rate: number;
  })[];
  const requestNight = p.request.night === night;
  const ids = bank.asked
    .filter((a) => a.week <= night)
    .map((a) => a.question_id);
  const foreign = bank.asked
    .filter((a) => a.week === night)
    .map((a) => question(a.question_id)!)
    .filter((q) => q.region !== "global" && q.region !== p.region).length;
  return {
    night,
    rounds: rs,
    closeness: marked.length
      ? marked.reduce((s, r) => s + Math.abs(r.rate - TARGET), 0) /
        marked.length
      : null,
    enjoyed:
      requestNight || !rs.length
        ? null
        : rs.filter((r) => enjoyment(p, r.genre as never, night) >= LIKED)
            .length / rs.length,
    foreign,
    requestCarried:
      night === p.request.night + 1
        ? rs.length
          ? rs.filter((r) => r.genre === p.request.genre).length / rs.length >=
            0.5
          : false
        : null,
    memoryForbidden: forbidden(notes, p, ids),
    memoryCarriesRequest: night >= p.request.night && carriesRequest(notes, p),
    varietyBroken: breaksVariety(
      p,
      night,
      rs,
      Array.from({ length: night - 1 }, (_, i) =>
        rounds(bank, i + 1).map((r) => ({ night: i + 1, genre: r.genre })),
      ).flat(),
    ),
  };
}
