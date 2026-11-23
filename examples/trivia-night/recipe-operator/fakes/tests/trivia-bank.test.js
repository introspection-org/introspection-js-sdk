import assert from "node:assert/strict";
import { test } from "node:test";
import {
  call,
  callTool,
  withFakes,
} from "@introspection-ai/eval-simulate/mcp/testing";
import { fakes } from "../mcp/index.ts";
import { world } from "../scenarios/index.ts";
import { options } from "./client.js";
import { supply } from "../mcp/trivia-bank/supply.ts";

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
