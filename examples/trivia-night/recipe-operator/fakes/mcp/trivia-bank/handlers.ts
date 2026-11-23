import {
  type McpServer,
  text,
  toolsOf,
} from "@introspection-ai/eval-simulate/mcp";
import { contract } from "./contract.ts";
import { randomOf } from "@introspection-ai/eval-simulate/mcp";
import { byId, chance } from "../../world/profiles.ts";
import type { Mark, Question, State } from "./entities.ts";
import { question, supply } from "./supply.ts";

const { config, answer } = toolsOf(contract);

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const tonight = (state: State) => state.nights.at(-1);

function standings(marks: Mark[], teams: string[]) {
  const points = new Map<string, number>(teams.map((t) => [t, 0]));
  for (const m of marks)
    points.set(m.team, (points.get(m.team) ?? 0) + (m.correct ? 1 : 0));
  return [...points.entries()]
    .map(([team, p]) => ({ team, points: p }))
    .sort((a, b) => b.points - a.points || a.team.localeCompare(b.team));
}

function rates(marks: Mark[], key: (q: Question) => string) {
  const out: Record<
    string,
    { asked: number; correct: number; correct_rate: number }
  > = {};
  for (const m of marks) {
    const q = question(m.question_id);
    if (!q) continue;
    const r = (out[key(q)] ??= { asked: 0, correct: 0, correct_rate: 0 });
    r.asked += 1;
    if (m.correct) r.correct += 1;
  }
  for (const r of Object.values(out))
    r.correct_rate = Math.round((r.correct / r.asked) * 100) / 100;
  return out;
}

export function register(server: McpServer, state: State) {
  server.registerTool(
    "next_questions",
    config("next_questions"),
    async ({ count, genre, region, difficulty }) => {
      const night = tonight(state);
      const asked = new Set(state.asked.map((a) => a.question_id));
      const fresh = supply().filter((q) => !asked.has(q.id));
      const match = (q: Question, d: number | undefined) =>
        (!genre || q.genre === genre) &&
        (!region || q.region === region) &&
        (d === undefined || q.difficulty === d);
      let pool = fresh.filter((q) => match(q, difficulty));
      let relaxed: string | null = null;
      // When the filter runs dry, the difficulty is relaxed to the nearest level that still has questions.
      if (pool.length < count && difficulty !== undefined) {
        for (const step of [1, 2, 3, 4]) {
          const near = [difficulty - step, difficulty + step].filter(
            (d) => d >= 1 && d <= 5,
          );
          const extra = fresh.filter((q) => near.some((d) => match(q, d)));
          if (pool.length + extra.length >= count || step === 4) {
            pool = [...pool, ...extra];
            relaxed = `difficulty widened to within ${step} of ${difficulty}`;
            break;
          }
        }
      }
      const picked = pool.slice(0, count);
      const week = night?.week ?? 0;
      const request = new Set(state.asked.map((a) => a.request)).size + 1;
      for (const q of picked)
        state.asked.push({ question_id: q.id, week, request });
      return answer("next_questions", {
        questions: picked.map(({ id, genre, region, difficulty, text }) => ({
          id,
          genre,
          region,
          difficulty,
          text,
        })),
        relaxed,
      });
    },
  );

  server.registerTool(
    "register_teams",
    config("register_teams"),
    async ({ names }) => {
      const night = tonight(state);
      if (!night)
        return text(
          "No night has been started at this venue. Call start_night first.",
          true,
        );
      const before = new Set(state.nights.slice(0, -1).flatMap((n) => n.teams));
      night.teams = [...new Set(names)];
      return answer("register_teams", {
        week: night.week,
        teams: night.teams.map((name) => ({
          name,
          played_here_before: before.has(name),
        })),
      });
    },
  );

  server.registerTool(
    "round_summary",
    config("round_summary"),
    async ({ week }) => {
      const w = week ?? tonight(state)?.week ?? 0;
      const marks = state.marks.filter((m) => m.week === w);
      return answer("round_summary", {
        week: w,
        by_genre: rates(marks, (q) => q.genre),
        by_difficulty: rates(marks, (q) => String(q.difficulty)),
      });
    },
  );

  server.registerTool("scoreboard", config("scoreboard"), async ({ scope }) => {
    const night = tonight(state);
    if (scope === "tonight") {
      if (!night) return text("No night has been started at this venue.", true);
      return answer("scoreboard", {
        scope,
        standings: standings(
          state.marks.filter((m) => m.week === night.week),
          night.teams,
        ),
      });
    }
    return answer("scoreboard", {
      scope,
      standings: standings(state.marks, []),
    });
  });

  server.registerTool("start_night", config("start_night"), async () => {
    const week = (tonight(state)?.week ?? 0) + 1;
    state.nights.push({ week, teams: [] });
    return answer("start_night", { week });
  });

  server.registerTool(
    "submit_round",
    config("submit_round"),
    async ({ answers }) => {
      const night = tonight(state);
      if (!night)
        return text(
          "No night has been started at this venue. Call start_night first.",
          true,
        );
      const servedTonight = new Set(
        state.asked
          .filter((a) => a.week === night.week)
          .map((a) => a.question_id),
      );
      for (const a of answers) {
        if (!servedTonight.has(a.question_id))
          return text(
            `Question ${a.question_id} was not asked at this venue tonight.`,
            true,
          );
        if (!night.teams.includes(a.team))
          return text(`Team "${a.team}" is not registered tonight.`, true);
      }
      const venue = state.venue ? byId(state.venue) : undefined;
      const marks: Mark[] = answers.map((a) => {
        const q = question(a.question_id) as Question;
        const given = normalise(a.answer);
        // In a memory search the crowd's answers are the world's: whether a team got a question right is
        // drawn from the venue's profile, keyed by the question and the team; a blank is always wrong.
        const correct = venue
          ? given !== "" &&
            randomOf(state.seed, venue.id, q.id, a.team)() <
              chance(venue, q, Math.max(0, venue.teams.indexOf(a.team)))
          : given !== "" && given === normalise(q.answer);
        return {
          week: night.week,
          question_id: a.question_id,
          team: a.team,
          answer: a.answer,
          correct,
        };
      });
      state.marks.push(...marks);
      return answer("submit_round", {
        week: night.week,
        marks: marks.map((m) => ({
          question_id: m.question_id,
          team: m.team,
          answer: m.answer,
          correct: m.correct,
          correct_answer: (question(m.question_id) as Question).answer,
        })),
        round_points: standings(marks, night.teams),
        standings: standings(
          state.marks.filter((m) => m.week === night.week),
          night.teams,
        ),
      });
    },
  );
}
