import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  call,
  callTool,
  withFakes,
} from "@introspection-ai/eval-simulate/mcp/testing";
import { fakes } from "../mcp/index.ts";
import { world } from "../scenarios/index.ts";
import { labelId } from "@introspection-ai/eval-simulate/mcp";
import { options } from "./client.js";
import {
  GENRES,
  PER_CELL,
  REAL_PER_CELL,
  REGIONS,
  SERIES_NIGHTS,
  nightOf,
  supply,
} from "../mcp/trivia-bank/supply.ts";
const questions = {};
for (const line of readFileSync(
  new URL("../mcp/trivia-bank/questions.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((l) => l.trim())) {
  const { cell, ...q } = JSON.parse(line);
  (questions[cell] ??= []).push(q);
}
import { ALL } from "../world/profiles.ts";

const json = (t) => JSON.parse(t);

test("a new venue has an empty summary and scoreboard", () =>
  withFakes(
    fakes,
    world,
    undefined,
    async ({ "trivia-bank": bank }) => {
      const s = json(await call(bank, "round_summary", {}));
      assert.deepEqual(s.by_genre, {});
      const b = json(await call(bank, "scoreboard", { scope: "season" }));
      assert.deepEqual(b.standings, []);
    },
    options,
  ));

test("registering teams before a night is started is refused and changes nothing", () =>
  withFakes(
    fakes,
    world,
    undefined,
    async ({ "trivia-bank": bank }) => {
      const r = await callTool(bank, "register_teams", { names: ["A"] });
      assert.equal(r.isError, true);
    },
    options,
  ));

test("a question is never given to the same venue twice, and a dry filter is relaxed", () =>
  withFakes(
    fakes,
    world,
    undefined,
    async ({ "trivia-bank": bank }) => {
      await call(bank, "start_night", {});
      const seen = new Set();
      for (let i = 0; i < 21; i++) {
        const r = json(
          await call(bank, "next_questions", {
            count: 10,
            genre: "film",
            region: "au",
            difficulty: 2,
          }),
        );
        for (const q of r.questions) {
          assert.ok(!seen.has(q.id));
          seen.add(q.id);
        }
        if (i < 20) assert.equal(r.relaxed, null);
        else assert.match(r.relaxed, /difficulty/);
      }
    },
    options,
  ));

test("a submitted round is marked by the bank and read back in the standings and summary", () =>
  withFakes(
    fakes,
    world,
    undefined,
    async ({ "trivia-bank": bank, states }) => {
      const { week } = json(await call(bank, "start_night", {}));
      assert.equal(week, 1);
      await call(bank, "register_teams", { names: ["A", "B"] });
      const { questions } = json(
        await call(bank, "next_questions", {
          count: 2,
          genre: "music",
          region: "global",
          difficulty: 3,
        }),
      );
      const truth = new Map(supply().map((q) => [q.id, q.answer]));
      const answerOf = (id) => truth.get(id) ?? "";
      const r = json(
        await call(bank, "submit_round", {
          answers: questions.flatMap((q) => [
            { question_id: q.id, team: "A", answer: answerOf(q.id) },
            { question_id: q.id, team: "B", answer: "" },
          ]),
        }),
      );
      assert.equal(r.marks.length, 4);
      assert.equal(
        r.marks.filter((m) => m.team === "B" && m.correct).length,
        0,
      );
      assert.equal(
        r.marks.filter((m) => m.team === "A" && m.correct).length,
        2,
      );
      const s = json(await call(bank, "round_summary", {}));
      assert.equal(s.by_genre.music.asked, 4);
      const t = json(await call(bank, "scoreboard", { scope: "tonight" }));
      assert.deepEqual(t.standings.map((x) => x.team).sort(), ["A", "B"]);
    },
    options,
  ));

test("an answer for a question not asked tonight is refused", () =>
  withFakes(
    fakes,
    world,
    undefined,
    async ({ "trivia-bank": bank }) => {
      await call(bank, "start_night", {});
      await call(bank, "register_teams", { names: ["A"] });
      const r = await callTool(bank, "submit_round", {
        answers: [{ question_id: "nope", team: "A", answer: "x" }],
      });
      assert.equal(r.isError, true);
    },
    options,
  ));

test("the returning venue's next night is week 4, with its teams known", () =>
  withFakes(
    fakes,
    world,
    "returning",
    async ({ "trivia-bank": bank }) => {
      assert.equal(json(await call(bank, "start_night", {})).week, 4);
      const r = json(
        await call(bank, "register_teams", {
          names: ["Team North", "New Team"],
        }),
      );
      assert.deepEqual(
        r.teams.map((t) => t.played_here_before),
        [true, false],
      );
      const s = json(await call(bank, "round_summary", { week: 3 }));
      assert.ok(s.by_genre.film.correct_rate > s.by_genre.science.correct_rate);
    },
    options,
  ));

// The world of one night of a series played in its own sandbox, as EVAL_SIMULATE_NIGHT sets it.
const onNight = (night) => (scenario, clock, seed) => {
  const w = world(scenario, clock, seed);
  w["trivia-bank"].series_night = night;
  return w;
};

// A host's two rounds of five, the second at the venue's own region.
const ROUNDS = [
  { count: 5, genre: "sport", region: "uk", difficulty: 3 },
  { count: 5, genre: "film", region: "global", difficulty: 2 },
];

async function servedOn(night) {
  let ids = [];
  await withFakes(
    fakes,
    onNight(night),
    "crowd-uk-sport",
    async ({ "trivia-bank": bank }) => {
      await call(bank, "start_night", {});
      for (const round of ROUNDS) {
        const r = json(await call(bank, "next_questions", round));
        assert.equal(r.relaxed, null);
        ids = [...ids, ...r.questions.map((q) => q.id)];
      }
    },
    options,
  );
  return ids;
}

test("each night of a series at a venue draws its own questions, the same for the same requests", async () => {
  const first = await servedOn(1);
  const second = await servedOn(2);
  const again = await servedOn(2);
  assert.equal(first.length, 10);
  assert.ok(!first.some((id) => second.includes(id)));
  assert.deepEqual(again, second);
});

test("every night's share of every venue holds two rounds of five in every cell", () => {
  for (const p of ALL)
    for (const genre of GENRES)
      for (const region of REGIONS)
        for (let difficulty = 1; difficulty <= 5; difficulty++) {
          const cell = supply().filter(
            (q) =>
              q.genre === genre &&
              q.region === region &&
              q.difficulty === difficulty,
          );
          for (let night = 1; night <= SERIES_NIGHTS; night++)
            assert.ok(
              cell.filter((q) => nightOf(p.id, q.id) === night).length >= 10,
              `${p.id} ${genre}/${region}/${difficulty} night ${night}`,
            );
        }
});

const cells = GENRES.flatMap((genre) =>
  REGIONS.flatMap((region) =>
    [1, 2, 3, 4, 5].map((difficulty) => ({ genre, region, difficulty })),
  ),
);
const DECADE = /^(196|197|198|199|200|201|202)0s$/;

test("questions.jsonl holds REAL_PER_CELL valid questions in each of the 120 cells, half of them multiple choice", () => {
  assert.equal(Object.keys(questions).length, 120);
  for (const { genre, region, difficulty } of cells) {
    const cell = questions[`${genre}-${region}-${difficulty}`];
    assert.equal(cell.length, REAL_PER_CELL);
    assert.equal(new Set(cell.map((q) => q.text)).size, REAL_PER_CELL);
    assert.equal(
      cell.filter((q) => q.format === "choice").length,
      REAL_PER_CELL / 2,
    );
    for (const q of cell) {
      assert.ok(q.text.trim() && q.answer.trim());
      assert.match(q.decade, DECADE);
      if (q.format === "choice") {
        assert.equal(q.options.length, 4);
        assert.equal(q.options.filter((o) => o === q.answer).length, 1);
      } else {
        assert.equal(q.format, "short");
        assert.equal(q.options, undefined);
      }
    }
  }
});

test("ids are unchanged, and the first REAL_PER_CELL of a cell come from questions.jsonl", () => {
  const all = supply();
  assert.equal(all.length, cells.length * PER_CELL);
  let i = 0;
  for (const { genre, region, difficulty } of cells) {
    const real = questions[`${genre}-${region}-${difficulty}`];
    for (let n = 0; n < PER_CELL; n++) {
      const q = all[i++];
      assert.equal(q.id, labelId(`${genre}-${region}-${difficulty}-${n}`));
      if (n < REAL_PER_CELL) {
        const { format, text, options, answer, decade } = real[n];
        assert.deepEqual(
          {
            format: q.format,
            text: q.text,
            options: q.options,
            answer: q.answer,
            decade: q.decade,
          },
          { format, text, options, answer, decade },
        );
      } else {
        assert.equal(q.format, "short");
        assert.equal(q.decade, undefined);
        assert.match(q.text, /^Practice /);
      }
    }
  }
});

async function firstRound(venue) {
  let served = [];
  await withFakes(
    fakes,
    world,
    venue,
    async ({ "trivia-bank": bank }) => {
      await call(bank, "start_night", {});
      served = json(await call(bank, "next_questions", ROUNDS[0])).questions;
    },
    options,
  );
  return served;
}

test("each venue meets its own shuffle of real questions, the same for the same request", async () => {
  const [a, b] = ALL.map((p) => p.id);
  const first = await firstRound(a);
  const other = await firstRound(b);
  const again = await firstRound(a);
  assert.notEqual(first[0].id, other[0].id);
  assert.deepEqual(again, first);
  for (const q of first) {
    assert.match(q.decade, DECADE);
    assert.ok(["choice", "short"].includes(q.format));
    if (q.format === "choice") assert.equal(q.options.length, 4);
  }
});

test("EVAL_SIMULATE_SERIES_NIGHTS splits each venue's real questions across that many nights", () => {
  const before = process.env.EVAL_SIMULATE_SERIES_NIGHTS;
  process.env.EVAL_SIMULATE_SERIES_NIGHTS = "2";
  try {
    assert.equal(
      world(ALL[0].id, new Date(), 0)["trivia-bank"].series_nights,
      2,
    );
  } finally {
    if (before === undefined) delete process.env.EVAL_SIMULATE_SERIES_NIGHTS;
    else process.env.EVAL_SIMULATE_SERIES_NIGHTS = before;
  }
  for (const p of ALL)
    for (const { genre, region, difficulty } of cells) {
      const real = supply().filter(
        (q) =>
          q.genre === genre &&
          q.region === region &&
          q.difficulty === difficulty &&
          q.decade,
      );
      for (const night of [1, 2])
        assert.ok(
          real.filter((q) => nightOf(p.id, q.id, 2) === night).length >= 12,
          `${p.id} ${genre}/${region}/${difficulty} night ${night}`,
        );
    }
});
