// Checks of the memory-search world, run before any candidate: it replays, nothing
// runs short, it can tell a host that suits the venue from one that ignores it,
// and each guard fires on its case only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { call, connect } from "@introspection-ai/eval-simulate/mcp/testing";
import { randomOf, startServices } from "@introspection-ai/eval-simulate/mcp";
import { fakes } from "../mcp/series.ts";
import { world } from "../scenarios/index.ts";
import {
  ALL,
  GENRES,
  TRAINING,
  chance,
  heldOut,
  enjoyment,
} from "../world/profiles.ts";
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
      await call(bank, "register_teams", { names: p.teams });
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
            p.teams.map((team) => ({ question_id: q.id, team, answer: "x" })),
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
