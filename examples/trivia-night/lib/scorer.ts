/**
 * The scorer: tonight's teams, their answers and the standings, per owner.
 * It takes a whole round's answers in one call and has the bank mark each, so
 * the host never handles a mark and cannot score generously.
 */
import { recordAnswer, servedIn, week, type Mark } from "./bank";
import type { Recorder } from "./events";

interface Scores {
  /** Points across every night, by team name. */
  season: Map<string, { nights: number; points: number }>;
  tonight: { week: number; teams: string[]; points: Map<string, number> };
  answered: Set<string>;
  /** Each submitted answer sheet: the questions one round covered. */
  rounds: { week: number; ids: string[] }[];
}

export interface TeamAnswer {
  question_id: string;
  team: string;
  answer: string;
}

export interface Standing {
  team: string;
  points: number;
}

const store = globalThis as unknown as { __triviaScores?: Map<string, Scores> };
const all = (store.__triviaScores ??= new Map());

function scores(owner: string): Scores {
  let found = all.get(owner);
  if (!found) {
    found = {
      season: new Map(),
      tonight: { week: 0, teams: [], points: new Map() },
      answered: new Set(),
      rounds: [],
    };
    all.set(owner, found);
  }
  return found;
}

export function resetScores(owner?: string): void {
  if (owner) all.delete(owner);
  else all.clear();
}

interface ScoresDump {
  season: [string, { nights: number; points: number }][];
  tonight: { week: number; teams: string[]; points: [string, number][] };
  answered: string[];
  rounds: { week: number; ids: string[] }[];
}

export function dumpScores(): Record<string, ScoresDump> {
  return Object.fromEntries(
    [...all].map(([owner, found]) => [
      owner,
      {
        season: [...found.season],
        tonight: { ...found.tonight, points: [...found.tonight.points] },
        answered: [...found.answered],
        rounds: found.rounds,
      },
    ]),
  );
}

export function loadScores(dump: Record<string, ScoresDump>): void {
  all.clear();
  for (const [owner, found] of Object.entries(dump))
    all.set(owner, {
      season: new Map(found.season),
      tonight: { ...found.tonight, points: new Map(found.tonight.points) },
      answered: new Set(found.answered),
      rounds: found.rounds ?? [],
    });
}

/** Tonight's teams and standings, and every round this owner submitted. */
export function scoresOf(owner: string): {
  tonight: { week: number; teams: string[]; standings: Standing[] };
  rounds: { week: number; ids: string[] }[];
} {
  const mine = scores(owner);
  return {
    tonight: {
      week: mine.tonight.week,
      teams: mine.tonight.teams,
      standings: ranked(mine.tonight.points),
    },
    rounds: mine.rounds,
  };
}

const ranked = (points: Map<string, number>): Standing[] =>
  [...points.entries()]
    .map(([team, value]) => ({ team, points: value }))
    .sort((a, b) => b.points - a.points || a.team.localeCompare(b.team));

/** Set tonight's teams. A team that has played here before is a regular. */
export function registerTeams(
  owner: string,
  names: string[],
): { week: number; teams: { name: string; regular: boolean }[] } {
  const tonight = week(owner);
  if (!tonight) throw new Error("call start_night before registering teams");
  const teams = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (!teams.length || teams.length > 20)
    throw new Error("a night has between 1 and 20 teams");
  const mine = scores(owner);
  mine.tonight = {
    week: tonight,
    teams,
    points: new Map(teams.map((team) => [team, 0])),
  };
  const result = teams.map((name) => ({
    name,
    regular: mine.season.has(name),
  }));
  for (const team of teams) {
    const record = mine.season.get(team) ?? { nights: 0, points: 0 };
    record.nights += 1;
    mine.season.set(team, record);
  }
  return { week: tonight, teams: result };
}

export interface RoundResult {
  questions: {
    question_id: string;
    accepted_answer: string;
    marks: (Pick<Mark, "correct" | "method"> & {
      team: string;
      answer: string;
    })[];
  }[];
  round_points: Standing[];
  standings: Standing[];
}

/** Mark one round's answer sheet: every team's answer to every question. */
export function submitRound(
  owner: string,
  answers: TeamAnswer[],
  recorder?: Recorder,
): RoundResult {
  const mine = scores(owner);
  const tonight = mine.tonight;
  if (tonight.week !== week(owner) || !tonight.teams.length)
    throw new Error("register tonight's teams before submitting a round");
  for (const { question_id, team } of answers) {
    if (!tonight.teams.includes(team))
      throw new Error(`"${team}" is not one of tonight's teams`);
    if (!servedIn(owner, question_id, tonight.week))
      throw new Error(`question ${question_id} was not asked tonight`);
    if (mine.answered.has(`${tonight.week}:${question_id}:${team}`))
      throw new Error(`"${team}" already answered ${question_id}`);
  }
  const round = new Map<string, number>();
  const questions = new Map<string, RoundResult["questions"][0]>();
  for (const { question_id, team, answer } of answers) {
    const mark = recordAnswer(owner, question_id, answer);
    mine.answered.add(`${tonight.week}:${question_id}:${team}`);
    let entry = questions.get(question_id);
    if (!entry)
      questions.set(
        question_id,
        (entry = {
          question_id,
          accepted_answer: mark.accepted_answer,
          marks: [],
        }),
      );
    entry.marks.push({
      team,
      answer,
      correct: mark.correct,
      method: mark.method,
    });
    round.set(team, (round.get(team) ?? 0) + (mark.correct ? 1 : 0));
    if (mark.correct) {
      tonight.points.set(team, (tonight.points.get(team) ?? 0) + 1);
      mine.season.get(team)!.points += 1;
    }
  }
  mine.rounds.push({ week: tonight.week, ids: [...questions.keys()] });
  const marks = [...questions.values()].flatMap((entry) => entry.marks);
  const count = (method: Mark["method"]) =>
    marks.filter((mark) => mark.method === method).length;
  recorder?.(
    owner,
    "bank.marked",
    `Marked ${marks.length} answers: ${marks.filter((mark) => mark.correct).length} right` +
      ` (${count("close")} close calls), ${count("wrong")} wrong, ${count("blank")} blank`,
    { questions: [...questions.values()] },
  );
  return {
    questions: [...questions.values()],
    round_points: ranked(round),
    standings: ranked(tonight.points),
  };
}

export function scoreboard(
  owner: string,
  scope: "tonight" | "season",
): { scope: string; standings: (Standing & { nights?: number })[] } {
  const mine = scores(owner);
  if (scope === "tonight")
    return { scope, standings: ranked(mine.tonight.points) };
  return {
    scope,
    standings: [...mine.season.entries()]
      .map(([team, record]) => ({ team, ...record }))
      .sort((a, b) => b.points - a.points || a.team.localeCompare(b.team)),
  };
}
