import assert from "node:assert/strict";
import { test } from "node:test";
import { call, withFakes } from "@introspection-ai/eval-simulate/mcp/testing";
import { fakes } from "../mcp/index.ts";
import { questionOf } from "../scenarios/bank.ts";
import { world } from "../scenarios/index.ts";
import { options } from "./client.js";

const round = (genre, region, level, from) =>
  Array.from(
    { length: 10 },
    (_, i) => `${i + 1}. ${questionOf(genre, region, level, from + i).text}`,
  ).join("\n");

test("the trivia master opens, answers each round, and ends the night after three", () =>
  withFakes(
    fakes,
    world,
    "venue-t1-uk",
    async (c) => {
      const open = await call(c.subject, "say", { text: "" });
      assert.match(open, /in the UK/);
      for (let r = 0; r < 3; r++) {
        const reply = await call(c.subject, "say", {
          text: round("film", "UK", 3, 1 + r * 10),
        });
        assert.match(reply, /Round's in\. 6 teams/);
      }
      assert.match(
        await call(c.subject, "say", { text: "Final scores..." }),
        /That's the night/,
      );
      const s = c.states.subject;
      assert.equal(s.nights[0].rounds.length, 3);
    },
    options,
  ));

test("questions already heard tonight are not a new round", () =>
  withFakes(
    fakes,
    world,
    "venue-t2-au",
    async (c) => {
      await call(c.subject, "say", { text: "" });
      await call(c.subject, "say", { text: round("sport", "AU", 2, 1) });
      const again = await call(c.subject, "say", {
        text: `Answers: ${round("sport", "AU", 2, 1)}`,
      });
      assert.match(again, /Ready for the next round/);
    },
    options,
  ));

test("a question is recognised whatever the case of its genre", () =>
  withFakes(
    fakes,
    world,
    "venue-t2-au",
    async (c) => {
      await call(c.subject, "say", { text: "" });
      const msg = Array.from(
        { length: 10 },
        (_, i) =>
          `${i + 1}. ${questionOf("tv", "AU", 2, i + 1).text.replace("tv", "TV")}`,
      ).join("\n");
      const reply = await call(c.subject, "say", { text: msg });
      assert.match(reply.split("\n")[1], /; 10\. /);
    },
    options,
  ));

test("a general question is recognised when 'for anywhere' is reworded or dropped", async () => {
  const { questionsIn } = await import("../scenarios/bank.ts");
  const qs = questionsIn(
    [
      "1. Sample sport question, level 3, no. 1: which code word pair goes with it?",
      "2. Sample film question, general, level 3, no. 4: which code word pair goes with it?",
      "3. Sample music question for the US, level 3, no. 10: which code word pair goes with it?",
      "4. Sample tv question, UK, level 2, no. 7: x",
    ].join("\n"),
  );
  assert.deepEqual(
    qs.map((q) => q.id),
    [
      "q-sport-general-3-001",
      "q-film-general-3-004",
      "q-music-us-3-010",
      "q-tv-uk-2-007",
    ],
  );
});
