import {
  type McpServer,
  text,
  toolsOf,
} from "@introspection-ai/eval-simulate/mcp";
import { contract } from "./contract.ts";
import { answersRight, byId, crowd } from "../../world/profiles.ts";
import type { Mark, Question, State } from "./entities.ts";
import { nightOf, question, shuffled, supply } from "./supply.ts";

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

/** The teams in the room when the crowd answers on its own: crowd_size of them, with night 2's turnover. */
function crowdTeams(state: State) {
  const venue = state.crowd && state.venue ? byId(state.venue) : undefined;
  return venue ? crowd(venue, state.crowd_size, state.series_night) : [];
}

/** Teams that played here on an earlier night: this bank's earlier nights, or night 1's crowd for a later series night. */
function playedBefore(state: State) {
  const before = new Set(state.nights.slice(0, -1).flatMap((n) => n.teams));
  const venue = state.crowd && state.venue ? byId(state.venue) : undefined;
  if (venue && (state.series_night ?? 1) >= 2)
    for (const team of crowd(venue, state.crowd_size, 1)) before.add(team);
  return before;
}

/** Tonight's rounds (one per next_questions call), each with its marks, for a crowd that answers on its own. */
function roundsOf(state: State, week: number) {
  const teams = crowdTeams(state);
  const byRequest = new Map<number, string[]>();
  for (const a of state.asked.filter((a) => a.week === week))
    byRequest.set(a.request, [
      ...(byRequest.get(a.request) ?? []),
      a.question_id,
    ]);
  return [...byRequest.values()].map((ids, i) => {
    const qs = ids.map((id) => question(id) as Question);
    const count = (g: string) => qs.filter((q) => q.genre === g).length;
    const marks = state.marks.filter(
      (m) => m.week === week && ids.includes(m.question_id),
    );
    return {
      round: i + 1,
      genre: [...qs.map((q) => q.genre)].sort((a, b) => count(b) - count(a))[0],
      difficulty:
        Math.round(
          (qs.reduce((s, q) => s + q.difficulty, 0) / qs.length) * 10,
        ) / 10,
      questions: qs.length,
      correct_rate: marks.length
        ? Math.round(
            (marks.filter((m) => m.correct).length / marks.length) * 100,
          ) / 100
        : 0,
      points: standings(marks, teams),
    };
  });
}

export function register(server: McpServer, state: State) {
  server.registerTool(
    "next_questions",
    config("next_questions"),
    async ({ count, genre, region, difficulty }) => {
      const night = tonight(state);
      const asked = new Set(state.asked.map((a) => a.question_id));
      const share = state.series_night;
      const fresh = shuffled(
        supply().filter(
          (q) =>
            !asked.has(q.id) &&
            (share === undefined ||
              nightOf(state.venue ?? "", q.id, state.series_nights) === share),
        ),
        state.venue ?? "",
        share ?? night?.week ?? 0,
      );
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
        state.asked.push({
          question_id: q.id,
          week,
          request,
          genre: q.genre,
          region: q.region,
          difficulty: q.difficulty,
          text: q.text,
          ...(q.options ? { options: q.options } : {}),
          answer: q.answer,
        });
      const venue = state.venue ? byId(state.venue) : undefined;
      if (state.crowd && venue)
        for (const q of picked)
          for (const team of crowdTeams(state))
            state.marks.push({
              week,
              question_id: q.id,
              team,
              answer: "",
              correct: answersRight(venue, q, team, state.seed),
            });
      return answer("next_questions", {
        questions: picked.map(
          ({
            id,
            genre,
            region,
            difficulty,
            format,
            text,
            options,
            decade,
          }) => ({
            id,
            genre,
            region,
            difficulty,
            format,
            text,
            ...(options && { options }),
            ...(decade && { decade }),
          }),
        ),
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
      const before = playedBefore(state);
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
        ...(state.crowd
          ? {
              rounds: roundsOf(state, w),
              standings: standings(marks, crowdTeams(state)),
            }
          : {}),
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
      if (state.crowd)
        return text(
          "The bank records this crowd's answers itself as each round is served; call round_summary for the marks.",
          true,
        );
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
          ? given !== "" && answersRight(venue, q, a.team, state.seed)
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
