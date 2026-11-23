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

const B = "question-bank";

test("listing filters by level, genre and region, and hides answers", () =>
  withFakes(
    fakes,
    world,
    "base",
    async (c) => {
      const r = JSON.parse(
        await call(c[B], "list_questions", {
          difficulty: 3,
          genre: "music",
          region: "UK",
          limit: 5,
        }),
      );
      assert.equal(r.questions.length, 5);
      for (const q of r.questions) {
        assert.deepEqual([q.genre, q.region, q.difficulty], ["music", "UK", 3]);
        assert.equal(q.answer, undefined);
      }
    },
    options,
  ));

test("an empty result, and an unknown genre is an error naming the genres", () =>
  withFakes(
    fakes,
    world,
    "us-sport-scarce",
    async (c) => {
      const r = JSON.parse(
        await call(c[B], "list_questions", {
          difficulty: 2,
          genre: "sport",
          region: "US",
          limit: 30,
        }),
      );
      assert.equal(r.total_available, 3);
      const bad = await callTool(c[B], "list_questions", {
        difficulty: 2,
        genre: "darts",
      });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /Genres: .*music/);
    },
    options,
  ));

test("a scored round is summarised, and its questions are not listed again", () =>
  withFakes(
    fakes,
    world,
    "base",
    async (c) => {
      const listed = JSON.parse(
        await call(c[B], "list_questions", {
          difficulty: 1,
          genre: "film",
          region: "general",
          limit: 2,
        }),
      );
      const ids = listed.questions.map((q) => q.id);
      const first = await callTool(c[B], "score_round", {
        question_ids: ids,
        teams: [{ team: "A", answers: ["", ""] }],
      });
      const scored = JSON.parse(first.text);
      const right = scored.answers.map((a) => a.answer.toUpperCase());
      const again = JSON.parse(
        await call(c[B], "score_round", {
          question_ids: ids,
          teams: [
            { team: "A", answers: right },
            { team: "B", answers: [right[0], "wrong"] },
          ],
        }),
      );
      assert.deepEqual(
        again.teams.map((t) => t.score),
        [2, 1],
      );
      const summary = JSON.parse(
        await call(c[B], "round_summary", { round_id: again.round_id }),
      );
      assert.equal(summary.percent_correct, 75);
      assert.equal(summary.difficulty, 1);
      const after = JSON.parse(
        await call(c[B], "list_questions", {
          difficulty: 1,
          genre: "film",
          region: "general",
          limit: 30,
        }),
      );
      assert.ok(after.questions.every((q) => !ids.includes(q.id)));
      assert.equal(after.total_available, listed.total_available - 2);
    },
    options,
  ));

test("a missing round and mismatched answers are errors that change nothing", () =>
  withFakes(
    fakes,
    world,
    "base",
    async (c) => {
      const missing = await callTool(c[B], "round_summary", {
        round_id: "round-9",
      });
      assert.equal(missing.isError, true);
      const mismatch = await callTool(c[B], "score_round", {
        question_ids: ["q-film-general-1-001"],
        teams: [{ team: "A", answers: ["x", "y"] }],
      });
      assert.equal(mismatch.isError, true);
    },
    options,
  ));
