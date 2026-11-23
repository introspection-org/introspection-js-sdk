// The world's own checks, run before any candidate (eval-simulate's world reference, step 5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { questionOf, cellKey, PER_CELL } from "../scenarios/bank.ts";
import { world } from "../scenarios/index.ts";
import { register } from "../mcp/subject/handlers.ts";
import { guards, scoreNight } from "../scoring.ts";
import {
  HELD_OUT,
  NIGHTS,
  PER_ROUND,
  ROUNDS,
  TRAINING,
  VENUES,
  pCorrect,
  skillOn,
} from "../venues.ts";

/** Drive the subject's handler directly, with no server: register captures the callback. */
function subjectOf(venueId, seed) {
  const w = world(`venue-${venueId}`, new Date("2026-11-20T19:00:00Z"), seed);
  let say;
  register(
    {
      registerTool: (_n, _c, fn) => {
        say = fn;
      },
    },
    w.subject,
  );
  return {
    state: w.subject,
    say: async (text) => (await say({ text })).content[0].text,
  };
}

/** A scripted host: `policy(venue, night, round, lastPct, lastLevel)` returns { genre, region, level } per question. */
async function playSeries(venue, seed, policy) {
  const s = subjectOf(venue.id, seed);
  const used = {};
  const scores = [];
  for (let n = 1; n <= NIGHTS; n++) {
    await s.say("");
    let last = null;
    for (let r = 0; r < ROUNDS; r++) {
      const picks = policy(venue, n, r, last);
      const text = picks
        .map((p, i) => {
          const key = cellKey(p.genre, p.region, p.level);
          used[key] = (used[key] ?? 0) + 1;
          return `${i + 1}. ${questionOf(p.genre, p.region, p.level, used[key]).text}`;
        })
        .join("\n");
      await s.say(text);
      const heard = s.state.nights.at(-1).rounds.at(-1);
      last = {
        pct:
          (100 * heard.correct.reduce((a, b) => a + b, 0)) /
          (heard.teams * PER_ROUND),
        level: picks[0].level,
      };
    }
    await s.say("Thanks all!");
    scores.push(scoreNight(venue, s.state.nights.at(-1)));
  }
  return { scores, used };
}

const adjust = (last, start) =>
  last == null
    ? start
    : last.pct > 75
      ? Math.min(5, last.level + 1)
      : last.pct < 55
        ? Math.max(1, last.level - 1)
        : last.level;
// Knows the venue (what a perfect memory would hold): liked genres, its region, the right level.
const informed = (v, n, r, last) => {
  const level = adjust(
    last,
    Math.min(5, Math.max(1, Math.round(skillOn(v, n)))),
  );
  return Array.from({ length: PER_ROUND }, (_, i) => ({
    genre: v.liked[i % v.liked.length],
    region: i % 2 ? "general" : v.region,
    level,
  }));
};
// Ignores the venue: the stated genres plus anything, level 3 to start, any region.
const ignorant = (v, n, r, last) => {
  const level = adjust(last, 3);
  const regions = ["general", "AU", "UK", "US"];
  const genres = [
    "music",
    "film",
    "tv",
    "sport",
    "history",
    "geography",
    "science",
    "food-and-drink",
    "literature",
    "christmas",
  ];
  return Array.from({ length: PER_ROUND }, (_, i) => ({
    genre: genres[(i + r * 3) % 10],
    region: regions[(i + r) % 4],
    level,
  }));
};

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const later = (scores) => scores.filter((s) => s.night > 1);

test("it replays: the same seed gives the same answers; a new seed changes only the room", async () => {
  const msg = Array.from(
    { length: 10 },
    (_, i) => questionOf("film", "UK", 3, i + 1).text,
  ).join("\n");
  const a = subjectOf("t1-uk", 1),
    b = subjectOf("t1-uk", 1),
    c = subjectOf("t1-uk", 2);
  for (const s of [a, b, c]) await s.say("");
  const [ra, rb, rc] = [await a.say(msg), await b.say(msg), await c.say(msg)];
  assert.equal(ra, rb);
  assert.notEqual(ra, rc);
  assert.equal(ra.split("\n").length, rc.split("\n").length);
});

test("nothing runs short: the greediest series uses well under the supply of one cell", async () => {
  for (const v of VENUES) {
    const greedy = (venue) =>
      Array.from({ length: PER_ROUND }, () => ({
        genre: venue.liked[0],
        region: venue.region,
        level: 3,
      }));
    const { used } = await playSeries(v, 0, greedy);
    for (const [key, n] of Object.entries(used)) {
      const region = key.split("|")[1];
      assert.ok(
        n * 3 <= PER_CELL[region],
        `${v.id} uses ${n} of ${PER_CELL[region]} in ${key}`,
      );
    }
  }
});

test("it can tell: a host that knows the venue beats one that ignores it, on every venue", async () => {
  for (const v of VENUES) {
    for (const seed of [0, 1]) {
      const good = later((await playSeries(v, seed, informed)).scores);
      const bad = later((await playSeries(v, seed, ignorant)).scores);
      assert.ok(
        mean(good.map((s) => s.liked_share)) >
          mean(bad.map((s) => s.liked_share)) + 0.3,
        `${v.id} liked share`,
      );
      assert.equal(
        good.reduce((a, s) => a + s.foreign, 0),
        0,
      );
      assert.ok(bad.reduce((a, s) => a + s.foreign, 0) > 10, `${v.id} foreign`);
      assert.ok(
        mean(good.map((s) => s.first_level_error)) <
          mean(bad.map((s) => s.first_level_error)) + 0.01,
        `${v.id} first level`,
      );
    }
  }
});

test("it can tell on rounds in band, averaged over venues", async () => {
  const good = [],
    bad = [];
  for (const v of VENUES)
    for (const seed of [0, 1, 2]) {
      good.push(
        ...later((await playSeries(v, seed, informed)).scores).map(
          (s) => s.in_band,
        ),
      );
      bad.push(
        ...later((await playSeries(v, seed, ignorant)).scores).map(
          (s) => s.in_band,
        ),
      );
    }
  console.log(
    `in band: informed ${mean(good).toFixed(2)}, ignorant ${mean(bad).toFixed(2)}`,
  );
  assert.ok(mean(good) > mean(bad) + 0.15);
});

test("a liked genre at the room's level lands near two in three", () => {
  for (const v of VENUES) {
    const lvl = Math.round(skillOn(v, 1));
    const p = pCorrect(v, 1, 0, {
      genre: v.liked[0],
      region: v.region,
      difficulty: lvl,
    });
    assert.ok(p > 0.5 && p < 0.9, `${v.id}: ${p}`);
  }
});

test("the held-out venues are fixed and differ in kind from training", () => {
  assert.equal(HELD_OUT.length, 6);
  assert.deepEqual(
    new Set(HELD_OUT.map((v) => v.kind)),
    new Set([
      "narrow tastes",
      "crowd getting sharper",
      "trivia master misjudges the crowd",
    ]),
  );
  assert.equal(TRAINING.length, 3);
});

test("each guard fires on its own case only", () => {
  const t2 = TRAINING.find((v) => v.request);
  const ok = [
    "Region: Australia.",
    "Likes: sport, tv, food and drink. Rounds in these land well.",
    "Music was played once as a one-off birthday request; not a preference.",
    "Start at level 2 next week; level 3 was too hard (about 40% right).",
  ].join("\n");
  const g0 = guards(t2, ok, 2);
  assert.deepEqual(g0, {
    team_names: [],
    scores: [],
    questions: [],
    one_night_request: [],
  });
  assert.equal(
    guards(t2, "Crowd loves music now.", 2).one_night_request.length,
    1,
  );
  assert.equal(
    guards(t2, "Crowd loves music now.", 1).one_night_request.length,
    0,
  );
  assert.equal(
    guards(t2, `${t2.teams[0].name} won again.`, 2).team_names.length,
    1,
  );
  assert.equal(guards(t2, "Top team got 9/10 in round 2.", 2).scores.length, 1);
  assert.equal(
    guards(t2, "Avoid q-sport-au-2-004, they hated it.", 2).questions.length,
    1,
  );
  assert.equal(guards(t2, "Winners got 24 out of 30.", 2).scores.length, 1);
  for (const fine of [
    "Genres about 4/3/3 a round.",
    "Level 4 ran 58/67/67% on night 2.",
    "The room scored 67% at level 3.",
    "Level 4 has scored 67-78%.",
  ])
    assert.equal(guards(t2, fine, 2).scores.length, 0, fine);
});
