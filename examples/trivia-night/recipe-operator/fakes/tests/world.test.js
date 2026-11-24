// Checks of the memory-search world, run before any candidate: it replays, nothing
// runs short, it can tell a host that suits the venue from one that ignores it,
// and each guard fires on its case only.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  call,
  callTool,
  connect,
} from "@introspection-ai/eval-simulate/mcp/testing";
import { randomOf, startServices } from "@introspection-ai/eval-simulate/mcp";
import { fakes } from "../mcp/series.ts";
import { world } from "../scenarios/index.ts";
import {
  ALL,
  CROWD_SIZES,
  GENRES,
  HELDOUT,
  PAGE,
  TRAINING,
  chance,
  crowd,
  heldOut,
  enjoyment,
  returning,
  teamOf,
} from "../world/profiles.ts";
import {
  MODEL,
  expected,
  sampleCrowd,
  strength,
  teamChance,
} from "../world/crowd.ts";
import {
  breaksVariety,
  carriesRequest,
  forbidden,
  scoreNight,
} from "../world/score.ts";

const json = (t) => JSON.parse(t);
const clock = new Date("2026-11-20T09:00:00Z");

// A scripted host: plays `nights` nights of `rounds` rounds, choosing each round with `choose`.
async function play(
  venueId,
  seed,
  choose,
  { nights = 4, rounds = 3, perRound = 8 } = {},
) {
  const services = await startServices(fakes, {
    world,
    scenario: venueId,
    clock,
    seed,
  });
  try {
    const bank = await connect(services, "trivia-bank");
    const subject = await connect(services, "subject");
    const p = ALL.find((x) => x.id === venueId);
    const relaxed = [];
    for (let night = 1; night <= nights; night++) {
      await call(subject, "say", { text: "" });
      await call(bank, "start_night", {});
      await call(bank, "register_teams", { names: crowd(p) });
      for (let r = 0; r < rounds; r++) {
        const { genre, difficulty, region } = choose(p, night, r);
        const got = json(
          await call(bank, "next_questions", {
            count: perRound,
            genre,
            difficulty,
            region,
          }),
        );
        if (got.relaxed) relaxed.push(got.relaxed);
        await call(subject, "say", {
          text: got.questions.map((q, i) => `${i + 1}. ${q.text}`).join("\n"),
        });
        await call(bank, "submit_round", {
          answers: got.questions.flatMap((q) =>
            crowd(p).map((team) => ({ question_id: q.id, team, answer: "x" })),
          ),
        });
      }
      await call(subject, "say", { text: "Final standings are in." });
    }
    return { state: structuredClone(services.states["trivia-bank"]), relaxed };
  } finally {
    await services.close();
  }
}

// Suits the venue: its liked genres, at the level its crowd answers two in three right.
const suits = (p, night, r) => {
  const liked = [...GENRES].sort(
    (a, b) => enjoyment(p, b, night) - enjoyment(p, a, night),
  );
  const enjoyed = liked.filter((g) => enjoyment(p, g, night) >= 0.6);
  const genre =
    r === 2 ? liked[enjoyed.length + (night % 2)] : enjoyed[r % enjoyed.length];
  const best = [1, 2, 3, 4, 5].sort(
    (a, b) =>
      Math.abs(
        chance(p, { genre, region: p.region, difficulty: a }, 1) - 2 / 3,
      ) -
      Math.abs(
        chance(p, { genre, region: p.region, difficulty: b }, 1) - 2 / 3,
      ),
  )[0];
  return { genre, region: p.region, difficulty: best };
};
// Ignores the venue: a genre at random, always level 3, general questions.
const ignoresWith = (seed) => (p, night, r) => ({
  genre: GENRES[Math.floor(randomOf(seed, p.id, night, r)() * 6)],
  region: "global",
  difficulty: 3,
});

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
function summary(state, venueId) {
  const nights = [2, 3, 4].map((n) => scoreNight(state, venueId, n, ""));
  return {
    closeness: mean(nights.map((n) => n.closeness)),
    enjoyed: mean(nights.map((n) => n.enjoyed).filter((x) => x !== null)),
  };
}

test("it replays: the same seed and calls give the same marks; a new seed changes only the marks", async () => {
  const a = await play("uk-sport", 1, suits, { nights: 2 });
  const b = await play("uk-sport", 1, suits, { nights: 2 });
  assert.deepEqual(a.state, b.state);
  const c = await play("uk-sport", 2, suits, { nights: 2 });
  assert.deepEqual(c.state.asked, a.state.asked);
  assert.notDeepEqual(
    c.state.marks.map((m) => m.correct),
    a.state.marks.map((m) => m.correct),
  );
});

test("nothing runs short: the greediest series (4 nights of 5 rounds of 8, one cell) is never relaxed", async () => {
  for (const p of [TRAINING[0], heldOut()[0]]) {
    const { relaxed } = await play(
      p.id,
      0,
      () => ({ genre: "film", region: p.region, difficulty: 3 }),
      { nights: 4, rounds: 5 },
    );
    assert.deepEqual(relaxed, []);
  }
});

test("it can tell: a host that suits the venue beats one that ignores it, on every venue", async () => {
  const rows = [];
  for (const p of ALL) {
    const goods = [],
      bads = [];
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      goods.push(summary((await play(p.id, seed, suits)).state, p.id));
      bads.push(
        summary((await play(p.id, seed, ignoresWith(seed))).state, p.id),
      );
    }
    const avg = (xs) => ({
      closeness: mean(xs.map((x) => x.closeness)),
      enjoyed: mean(xs.map((x) => x.enjoyed)),
    });
    const good = avg(goods),
      bad = avg(bads);
    rows.push({ venue: p.id, good, bad });
    assert.ok(
      good.enjoyed > bad.enjoyed + 0.2,
      `${p.id}: enjoyed ${good.enjoyed} vs ${bad.enjoyed}`,
    );
    // Closeness separates the two only where the crowd's level is away from the level-3 default.
    if (Math.abs(p.level - 3) >= 0.7)
      assert.ok(
        good.closeness < bad.closeness,
        `${p.id}: closeness ${good.closeness} vs ${bad.closeness}`,
      );
  }
  console.log("ROWS" + JSON.stringify(rows));
  assert.ok(
    mean(rows.map((r) => r.good.closeness)) <
      mean(rows.map((r) => r.bad.closeness)),
    "closeness overall",
  );
});

test("an other-country question is counted and almost never answered", async () => {
  const p = TRAINING[0];
  const { state } = await play(
    p.id,
    3,
    () => ({ genre: "film", region: "uk", difficulty: 2 }),
    { nights: 1, rounds: 1 },
  );
  const night = scoreNight(state, p.id, 1, "");
  assert.equal(night.foreign, 8);
  assert.ok(night.rounds[0].rate < 0.2);
});

test("the memory guards fire on their case only, negations included", () => {
  const p = TRAINING[0]; // teams include "Quizzly Bears"; request: Priya, science
  assert.deepEqual(
    forbidden("Crowd loves film and music. Start at level 4.", p, []),
    [],
  );
  assert.deepEqual(
    forbidden("Never write team names, scores or standings here.", p, []),
    [],
  );
  assert.deepEqual(
    forbidden(
      "Give it about 3 rounds in 5 (2 of 3 on a short night). The all-film night was not a standing preference.",
      p,
      [],
    ),
    [],
  );
  assert.ok(forbidden("Quizzly Bears are the strongest team.", p, []).length);
  assert.ok(forbidden("Round one: 14 out of 24.", p, []).length);
  assert.ok(forbidden("Film round: 20/24 right.", p, []).length);
  assert.ok(forbidden("Winners last week scored 14 points.", p, []).length);
  assert.ok(
    forbidden("Asked: Practice film question about Australia", p, []).length,
  );
  assert.equal(carriesRequest("Crowd enjoys film and music.", p), false);
  assert.equal(
    carriesRequest(
      "All-science night was a one-off birthday request, not a preference.",
      p,
    ),
    false,
  );
  assert.equal(carriesRequest("Science: they don't enjoy it much.", p), false);
  assert.equal(
    carriesRequest(
      "- Less keen: geography, history and science. Science got groans every round on an all-science night.",
      p,
    ),
    false,
  );
  assert.equal(
    carriesRequest(
      "Keep music, film and science occasional, a level lower than the liked genres.",
      p,
    ),
    false,
  );
  assert.equal(
    carriesRequest(
      "- Order: opening with a level-3 genre (science or history) lands well but holds the first favourite round at 3, which runs easy.",
      p,
    ),
    false,
  );
  assert.equal(carriesRequest("Crowd loves science now.", p), true);
  assert.equal(carriesRequest("Science is now a favourite here.", p), true);
  assert.equal(
    carriesRequest("Priya's birthday night was all science.", p),
    true,
  );
});

test("the variety guard fires only when every round is in a genre the host already had reason to think liked", () => {
  const p = TRAINING[0]; // stated: film, music; loves film (0.9) and music (0.85); request night 3
  const r = (genre) => ({
    genre,
    difficulty: 3,
    regions: ["au"],
    questions: 8,
    rate: 0.6,
  });
  // Named as liked by the trivia master: breaks.
  assert.equal(breaksVariety(p, 2, [r("film"), r("music"), r("film")]), true);
  // A round outside the known likes: holds.
  assert.equal(breaksVariety(p, 2, [r("film"), r("music"), r("sport")]), false);
  // The request night never breaks.
  assert.equal(breaksVariety(p, 3, [r("film"), r("film"), r("film")]), false);
  assert.equal(breaksVariety(p, 2, []), false);
  const q = TRAINING[2]; // stated: science only; loves science (0.85) and geography (0.8)
  // Geography never played or named before tonight: doesn't count, even though the crowd likes it.
  assert.equal(
    breaksVariety(q, 2, [r("geography"), r("science"), r("science")]),
    false,
  );
  // Geography loved in an earlier round at the venue: now it counts.
  assert.equal(
    breaksVariety(
      q,
      2,
      [r("geography"), r("science"), r("science")],
      [{ night: 1, genre: "geography" }],
    ),
    true,
  );
  // Loved earlier tonight counts for later rounds tonight.
  assert.equal(
    breaksVariety(q, 2, [r("science"), r("science"), r("science")]),
    true,
  );
  // A genre that only "went down fine" earlier is not a known like (history 0.4 for q).
  assert.equal(
    breaksVariety(
      q,
      2,
      [r("science"), r("history"), r("science")],
      [{ night: 1, genre: "history" }],
    ),
    false,
  );
});

test("every venue has eight distinct teams", () => {
  const names = ALL.flatMap((p) => p.teams);
  assert.equal(new Set(names).size, names.length);
  for (const p of [...ALL, ...PAGE, ...HELDOUT])
    assert.equal(p.teams.length, 8, p.id);
});

test("a venue's crowd is drawn from its id: the same venue seats the same teams", () => {
  for (const p of [PAGE[0], HELDOUT[0]]) {
    const a = sampleCrowd(p.id, p.region, p.teams, p.draw);
    const b = sampleCrowd(p.id, p.region, p.teams, p.draw);
    assert.deepEqual(a, b);
    assert.deepEqual(teamOf(p, p.teams[2]), a[2]);
    for (const team of a)
      assert.ok(team.members.length >= 3 && team.members.length <= 6);
  }
  assert.notDeepEqual(
    sampleCrowd("one", "uk", ["A", "B"]),
    sampleCrowd("two", "uk", ["A", "B"]),
  );
});

test("a derived venue's tastes and level come from its crowd", () => {
  for (const p of PAGE) {
    const ranked = [...GENRES].sort((a, b) => p.enjoy[b] - p.enjoy[a]);
    assert.deepEqual(p.stated, ranked.slice(0, 1), p.id);
    assert.ok(p.level >= 1 && p.level <= 5, p.id);
    assert.equal(p.decades?.length, 2, p.id);
  }
});

test("team strengths spread, and all-star teams are rare", () => {
  const strengths = [...PAGE, ...HELDOUT].flatMap((p) =>
    p.teams.map((name) => strength(teamOf(p, name), p.region)),
  );
  const sorted = [...strengths].sort((a, b) => a - b);
  const at = (q) => sorted[Math.round(q * (sorted.length - 1))];
  assert.ok(at(0.05) > 0.25 && at(0.05) < 0.5, `p5 ${at(0.05)}`);
  assert.ok(at(0.5) > 0.45 && at(0.5) < 0.62, `p50 ${at(0.5)}`);
  assert.ok(at(0.95) < 0.75, `p95 ${at(0.95)}`);
  assert.ok(strengths.filter((x) => x >= 0.7).length / strengths.length < 0.05);
  // No team is perfect: conferring caps every team below its members' chance.
  assert.ok(sorted.at(-1) <= MODEL.CONFER);
});

test("calibration: a typical team gets about 70% of its favourite genre and 40% of its least at difficulty 3", () => {
  const rows = [...PAGE, ...HELDOUT].flatMap((p) =>
    p.teams.map((name) => {
      const team = teamOf(p, name);
      const interest = Object.fromEntries(
        GENRES.map((g) => [
          g,
          team.members.reduce((s, m) => s + m.interest[g], 0),
        ]),
      );
      const order = [...GENRES].sort((a, b) => interest[b] - interest[a]);
      return {
        in: expected([team], [order[0]], 3, p.region),
        out: expected([team], [order.at(-1)], 3, p.region),
      };
    }),
  );
  const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const inside = median(rows.map((r) => r.in));
  const outside = median(rows.map((r) => r.out));
  assert.ok(inside >= 0.65 && inside <= 0.77, `in ${inside}`);
  assert.ok(outside >= 0.35 && outside <= 0.45, `out ${outside}`);
});

test("cohort: a team of sixty-somethings beats a team of twenty-somethings on 1970s questions, and loses on 2010s", () => {
  const interest = Object.fromEntries(GENRES.map((g) => [g, 0.5]));
  const team = (age) => ({
    name: String(age),
    members: [age, age, age, age].map((a) => ({
      age: a,
      interest,
      local: true,
    })),
  });
  const old = team(66);
  const young = team(24);
  const q = (decade) => ({
    genre: "music",
    region: "uk",
    difficulty: 3,
    decade,
  });
  assert.ok(
    teamChance(old, q("1970s"), "uk") >
      teamChance(young, q("1970s"), "uk") + 0.1,
  );
  assert.ok(
    teamChance(young, q("2010s"), "uk") > teamChance(old, q("2010s"), "uk"),
  );
});

test("turnover: night 2 keeps about four in five of night 1's teams, by a seeded draw", () => {
  for (const p of [...PAGE, ...HELDOUT])
    for (const n of CROWD_SIZES) {
      const night1 = crowd(p, n, 1);
      const night2 = crowd(p, n, 2);
      assert.deepEqual(crowd(p, n, 2), night2, "deterministic");
      assert.deepEqual(crowd(p, n, 3), night2, "later nights keep night 2's");
      assert.equal(night2.length, n);
      assert.equal(new Set(night2).size, n);
      const back = night2.filter((t) => night1.includes(t));
      assert.deepEqual(back, returning(p, n));
      const allowed = { 3: [2, 3], 5: [4], 8: [6, 7] }[n];
      assert.ok(allowed.includes(back.length), `${p.id} ${n}: ${back.length}`);
      for (const t of night2.filter((t) => !night1.includes(t)))
        assert.ok(!p.teams.includes(t), `${t} is new to ${p.id}`);
    }
  // Without a series night (a memory search's bank) the crowd never changes.
  assert.deepEqual(crowd(PAGE[0], 5), crowd(PAGE[0], 5, 1));
});

// A platform eval's venue: the crowd answers on its own, so a fresh night 2 (without memory)
// and a night 2 after night 1 (with) face the same teams answering the same question the same way.
test("a crowd venue marks the same question the same way for the same team, on any night and in any run", async () => {
  const p = ALL.find((x) => x.id === "uk-sport");
  const round = { count: 5, genre: "sport", region: "uk", difficulty: 2 };
  async function night2(playNight1) {
    const services = await startServices(fakes, {
      world,
      scenario: "crowd-uk-sport",
      clock,
      seed: 0,
    });
    try {
      const bank = await connect(services, "trivia-bank");
      await call(bank, "start_night", {});
      if (playNight1)
        await call(bank, "next_questions", { ...round, genre: "history" });
      await call(bank, "start_night", {});
      const got = json(await call(bank, "next_questions", round));
      const summary = json(await call(bank, "round_summary", {}));
      const refused = await callTool(bank, "submit_round", {
        answers: [
          { question_id: got.questions[0].id, team: p.teams[0], answer: "x" },
        ],
      });
      const marks = services.states["trivia-bank"].marks
        .filter((m) => m.week === 2)
        .map(({ question_id, team, correct }) => ({
          question_id,
          team,
          correct,
        }));
      return { marks, summary, refused };
    } finally {
      await services.close();
    }
  }
  const withMemory = await night2(true);
  const without = await night2(false);
  assert.equal(withMemory.marks.length, 25);
  assert.deepEqual(withMemory.marks, without.marks);
  assert.deepEqual(withMemory.marks.map((m) => m.team).slice(0, 5), crowd(p));
  const [r] = withMemory.summary.rounds;
  assert.deepEqual(
    {
      round: r.round,
      genre: r.genre,
      difficulty: r.difficulty,
      questions: r.questions,
    },
    { round: 1, genre: "sport", difficulty: 2, questions: 5 },
  );
  assert.equal(
    r.correct_rate,
    Math.round((withMemory.marks.filter((m) => m.correct).length / 25) * 100) /
      100,
  );
  assert.equal(withMemory.summary.standings.length, 5);
  assert.ok(withMemory.refused.isError);
});

// EVAL_SIMULATE_TEAMS picks the crowd: the profile's first n teams on night 1; night 2 brings most
// of them back with new teams, the same roster in every arm, and register_teams flags who returned.
for (const size of [3, 5, 8])
  test(`a ${size}-team crowd marks exactly ${size} teams, night 2 with turnover`, async () => {
    const p = PAGE.find((x) => x.id === "page-manchester");
    const before = {
      teams: process.env.EVAL_SIMULATE_TEAMS,
      night: process.env.EVAL_SIMULATE_NIGHT,
    };
    const teamsOn = async (night) => {
      process.env.EVAL_SIMULATE_TEAMS = String(size);
      process.env.EVAL_SIMULATE_NIGHT = String(night);
      const services = await startServices(fakes, {
        world,
        scenario: "crowd-page-manchester",
        clock,
        seed: 0,
      });
      try {
        const bank = await connect(services, "trivia-bank");
        await call(bank, "start_night", {});
        const registered = json(
          await call(bank, "register_teams", { names: crowd(p, size, night) }),
        );
        const got = json(
          await call(bank, "next_questions", { count: 5, region: "uk" }),
        );
        const summary = json(await call(bank, "round_summary", {}));
        const marks = services.states["trivia-bank"].marks;
        assert.equal(marks.length, got.questions.length * size);
        for (const q of got.questions)
          assert.equal(
            new Set(
              marks.filter((m) => m.question_id === q.id).map((m) => m.team),
            ).size,
            size,
          );
        assert.equal(summary.standings.length, size);
        return {
          teams: [...new Set(marks.map((m) => m.team))],
          before: registered.teams
            .filter((t) => t.played_here_before)
            .map((t) => t.name),
        };
      } finally {
        await services.close();
      }
    };
    try {
      const night1 = await teamsOn(1);
      const night2 = await teamsOn(2);
      const again = await teamsOn(2);
      assert.deepEqual(night1.teams, crowd(p, size));
      assert.deepEqual(night1.before, []);
      assert.deepEqual(night2.teams, crowd(p, size, 2));
      assert.deepEqual(night2.before, returning(p, size));
      // Every night-2 arm starts a fresh bank and faces the same roster.
      assert.deepEqual(again, night2);
    } finally {
      for (const [key, value] of [
        ["EVAL_SIMULATE_TEAMS", before.teams],
        ["EVAL_SIMULATE_NIGHT", before.night],
      ])
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });
