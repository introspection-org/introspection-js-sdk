/**
 * The question bank. It owns the facts: which questions each owner has been
 * asked and how their teams answered. An owner is whoever the caller's
 * credential names (a venue here), never a value the agent passes in, so the
 * host cannot ask on another venue's behalf or forget what was already asked.
 */
import type { Recorder } from "./events";
import { QUESTIONS, type Genre, type Question, type Region } from "./questions";

export interface Asked {
  question_id: string;
  week: number;
  genre: Genre;
  difficulty: number;
  answers: number;
  correct: number;
  /** Teams that wrote nothing: a sign the room gave up, not that it guessed wrong. */
  blanks: number;
}

interface History {
  week: number;
  asked: Map<string, Asked>;
}

export interface Filter {
  count: number;
  genre?: Genre;
  region?: Region;
  difficulty?: number;
}

export type Served = Omit<Question, "answer" | "aliases">;

export interface Mark {
  question_id: string;
  correct: boolean;
  /** How the bank decided: only `close` answers are a judgement call. */
  method: "exact" | "alias" | "close" | "wrong" | "blank";
  accepted_answer: string;
}

const store = globalThis as unknown as {
  __triviaBank?: Map<string, History>;
};
const histories = (store.__triviaBank ??= new Map());

function history(owner: string): History {
  let found = histories.get(owner);
  if (!found) {
    found = { week: 0, asked: new Map() };
    histories.set(owner, found);
  }
  return found;
}

export function reset(owner?: string): void {
  if (owner) histories.delete(owner);
  else histories.clear();
}

/** Start the owner's next quiz night. */
export function nextWeek(owner: string): number {
  return (history(owner).week += 1);
}

export function week(owner: string): number {
  return history(owner).week;
}

const ARTICLES = /^(the|a|an)\s+/;

export function normalise(answer: string): string {
  return answer
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9. ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(ARTICLES, "");
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length];
}

/** A misspelling of a word answer; a number is right or wrong, never close. */
function close(given: string, accepted: string): boolean {
  if (accepted.length < 5 || /\d/.test(accepted)) return false;
  return distance(given, accepted) <= (accepted.length >= 10 ? 2 : 1);
}

export function mark(question: Question, answer: string): Mark["method"] {
  const given = normalise(answer);
  if (!given) return "blank";
  if (given === normalise(question.answer)) return "exact";
  const aliases = question.aliases.map(normalise);
  if (aliases.includes(given)) return "alias";
  return [normalise(question.answer), ...aliases].some((accepted) =>
    close(given, accepted),
  )
    ? "close"
    : "wrong";
}

const serve = ({ answer: _answer, aliases: _aliases, ...rest }: Question) =>
  rest;

/**
 * Questions this owner has not been asked, nearest to the filter. When the
 * filter runs dry it is relaxed in a fixed order, and the result says how:
 * region to global, difficulty by one step, any difficulty, then any genre.
 */
export function nextQuestions(
  owner: string,
  filter: Filter,
  recorder?: Recorder,
): { questions: Served[]; relaxed: string[] } {
  const mine = history(owner);
  const unseen = QUESTIONS.filter((item) => !mine.asked.has(item.id));
  const region = (item: Question, strict: boolean) =>
    !filter.region ||
    item.region === filter.region ||
    (!strict && item.region === "global");
  const steps: { relaxed?: string; keep: (item: Question) => boolean }[] = [
    {
      keep: (item) =>
        (!filter.genre || item.genre === filter.genre) &&
        region(item, true) &&
        (!filter.difficulty || item.difficulty === filter.difficulty),
    },
    {
      relaxed: "region widened to global",
      keep: (item) =>
        (!filter.genre || item.genre === filter.genre) &&
        region(item, false) &&
        (!filter.difficulty || item.difficulty === filter.difficulty),
    },
    {
      relaxed: "difficulty widened by one step",
      keep: (item) =>
        (!filter.genre || item.genre === filter.genre) &&
        region(item, false) &&
        (!filter.difficulty ||
          Math.abs(item.difficulty - filter.difficulty) <= 1),
    },
    {
      relaxed: "any difficulty",
      keep: (item) =>
        (!filter.genre || item.genre === filter.genre) && region(item, false),
    },
    { relaxed: "any genre", keep: (item) => region(item, false) },
  ];
  const chosen: Question[] = [];
  const relaxed: string[] = [];
  for (const step of steps) {
    if (chosen.length >= filter.count) break;
    const more = unseen.filter(
      (item) => step.keep(item) && !chosen.includes(item),
    );
    if (more.length && step.relaxed) relaxed.push(step.relaxed);
    chosen.push(...more.slice(0, filter.count - chosen.length));
  }
  for (const item of chosen)
    mine.asked.set(item.id, {
      question_id: item.id,
      week: mine.week,
      genre: item.genre,
      difficulty: item.difficulty,
      answers: 0,
      correct: 0,
      blanks: 0,
    });
  recorder?.(
    owner,
    "bank.served",
    `Served ${chosen.length} unseen question${chosen.length === 1 ? "" : "s"}` +
      ` (${mine.asked.size - chosen.length} already asked here were excluded)`,
    { filter, ids: chosen.map((item) => item.id) },
  );
  if (relaxed.length)
    recorder?.(owner, "bank.relaxed", `Filter ran dry: ${relaxed.join(", ")}`, {
      filter,
      relaxed,
    });
  return { questions: chosen.map(serve), relaxed };
}

export function recordAnswer(
  owner: string,
  questionId: string,
  answer: string,
  recorder?: Recorder,
): Mark {
  const asked = history(owner).asked.get(questionId);
  const question = QUESTIONS.find((item) => item.id === questionId);
  if (!asked || !question)
    throw new Error(`question ${questionId} was not served to this owner`);
  const method = mark(question, answer);
  const correct = method !== "wrong" && method !== "blank";
  asked.answers += 1;
  if (correct) asked.correct += 1;
  if (method === "blank") asked.blanks += 1;
  recorder?.(
    owner,
    "bank.marked",
    `${questionId}: "${answer}" marked ${correct ? "right" : "wrong"} (${method})`,
    { question_id: questionId, answer, method },
  );
  return {
    question_id: questionId,
    correct,
    method,
    accepted_answer: question.answer,
  };
}

export interface Tally {
  answers: number;
  correct: number;
  blanks: number;
  rate: number;
}

export interface Summary {
  week: number;
  asked_total: number;
  by_genre: Record<string, Tally>;
  by_difficulty: Record<string, Tally>;
  overall: Tally;
}

/** How one of the owner's weeks went; the current week when none is named. */
export function summary(owner: string, ofWeek?: number): Summary {
  const mine = history(owner);
  const target = ofWeek ?? mine.week;
  const tally = (): Tally => ({ answers: 0, correct: 0, blanks: 0, rate: 0 });
  const result: Summary = {
    week: target,
    asked_total: mine.asked.size,
    by_genre: {},
    by_difficulty: {},
    overall: tally(),
  };
  for (const asked of mine.asked.values()) {
    if (asked.week !== target) continue;
    const groups = [
      (result.by_genre[asked.genre] ??= tally()),
      (result.by_difficulty[asked.difficulty] ??= tally()),
      result.overall,
    ];
    for (const group of groups) {
      group.answers += asked.answers;
      group.correct += asked.correct;
      group.blanks += asked.blanks;
      group.rate = group.answers ? group.correct / group.answers : 0;
    }
  }
  return result;
}

/** Whether the owner was served this question in the given week. */
export function servedIn(
  owner: string,
  questionId: string,
  ofWeek: number,
): boolean {
  return history(owner).asked.get(questionId)?.week === ofWeek;
}

/** Every question id the owner has been asked, for checks. */
export function askedIds(owner: string): string[] {
  return [...history(owner).asked.keys()];
}
