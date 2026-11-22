/** Checks of the bank, its MCP server and the scoring: `pnpm test`. */
import assert from "node:assert/strict";

process.env.TRIVIA_DEV_OWNER_HEADER = "1";

async function main() {
  const {
    askedIds,
    mark,
    nextQuestions,
    nextWeek,
    recordAnswer,
    reset,
    summary,
  } = await import("../lib/bank");
  const { serve } = await import("../lib/mcp");
  const { QUESTIONS } = await import("../lib/questions");
  const { simulate } = await import("./simulate");

  let passed = 0;
  async function check(name: string, run: () => void | Promise<void>) {
    await run();
    passed += 1;
    console.log(`ok  ${name}`);
  }

  const question = (id: string) => QUESTIONS.find((item) => item.id === id)!;

  await check(
    "question ids are unique and every question has an answer",
    () => {
      assert.equal(
        new Set(QUESTIONS.map((item) => item.id)).size,
        QUESTIONS.length,
      );
      for (const item of QUESTIONS)
        assert.ok(item.answer && item.text.endsWith("?"));
    },
  );

  await check("marking: exact, alias, misspelling, wrong", () => {
    assert.equal(mark(question("mu-01"), "the beatles"), "exact");
    assert.equal(mark(question("mu-01"), "Beatles!"), "exact");
    assert.equal(mark(question("fi-02"), "spielberg"), "alias");
    assert.equal(mark(question("fi-05"), "Quentin Tarentino"), "close");
    assert.equal(mark(question("fi-05"), "Steven Spielberg"), "wrong");
    assert.equal(mark(question("mu-05"), "Quee"), "close");
    assert.equal(mark(question("sc-01"), "H2O"), "exact");
  });

  await check("marking: a number is never close", () => {
    assert.equal(mark(question("hi-02"), "1946"), "wrong");
    assert.equal(mark(question("sp-10"), "99.84"), "wrong");
    assert.equal(mark(question("sp-10"), "99.94"), "exact");
  });

  await check("a venue is never served the same question twice", () => {
    reset();
    nextWeek("a");
    const seen = new Set<string>();
    for (let round = 0; round < 30; round += 1)
      for (const item of nextQuestions("a", { count: 4 }).questions) {
        assert.ok(!seen.has(item.id), `${item.id} repeated`);
        seen.add(item.id);
      }
    assert.equal(seen.size, QUESTIONS.length);
    assert.equal(nextQuestions("a", { count: 4 }).questions.length, 0);
  });

  await check("served questions carry no answer", () => {
    reset();
    for (const item of nextQuestions("a", { count: 5 }).questions) {
      assert.ok(!("answer" in item));
      assert.ok(!("aliases" in item));
    }
  });

  await check("venues do not share history", () => {
    reset();
    const first = nextQuestions("a", { count: 3, genre: "film" }).questions;
    const second = nextQuestions("b", { count: 3, genre: "film" }).questions;
    assert.deepEqual(
      first.map((item) => item.id),
      second.map((item) => item.id),
    );
    assert.throws(() => recordAnswer("c", first[0].id, "x"));
  });

  await check("a dry filter is relaxed in order and says so", () => {
    reset();
    const strict = nextQuestions("a", {
      count: 3,
      genre: "sport",
      region: "au",
      difficulty: 2,
    });
    assert.deepEqual(
      strict.questions.map((item) => item.id),
      ["sp-09", "sp-03", "sp-04"],
    );
    assert.deepEqual(strict.relaxed, ["region widened to global"]);
    assert.ok(strict.questions.every((item) => item.region !== "uk"));
  });

  await check("a summary counts one week only", () => {
    reset();
    nextWeek("a");
    const [first] = nextQuestions("a", { count: 1, genre: "music" }).questions;
    recordAnswer("a", first.id, question(first.id).answer);
    recordAnswer("a", first.id, "nope");
    nextWeek("a");
    assert.equal(summary("a", 1).overall.rate, 0.5);
    assert.equal(summary("a").overall.answers, 0);
    assert.equal(askedIds("a").length, 1);
  });

  const rpc = (
    method: string,
    params: Record<string, unknown> | undefined,
    headers: Record<string, string>,
  ) =>
    serve(
      new Request("http://bank.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
  const result = async (response: Response) =>
    JSON.parse((await response.text()).split("data: ")[1]).result;
  const tool = async (
    name: string,
    args: Record<string, unknown>,
    headers: Record<string, string>,
  ) =>
    JSON.parse(
      (
        await result(
          await rpc("tools/call", { name, arguments: args }, headers),
        )
      ).content[0].text,
    );

  await check(
    "the MCP server refuses a call that names no end user",
    async () => {
      assert.equal((await rpc("initialize", {}, {})).status, 401);
      const spoofed = await rpc(
        "tools/call",
        {
          name: "next_questions",
          arguments: { count: 1, owner: "the-anchor" },
        },
        {},
      );
      assert.equal(spoofed.status, 401);
    },
  );

  await check(
    "the MCP server keys history on the caller, not an argument",
    async () => {
      reset();
      const open = async (owner: string) => {
        const response = await rpc(
          "initialize",
          {},
          { "x-trivia-owner": owner },
        );
        return {
          "x-trivia-owner": owner,
          "mcp-session-id": response.headers.get("mcp-session-id")!,
        };
      };
      const anchor = await open("venue:the-anchor");
      const quill = await open("venue:quiz-and-quill");
      const tools = (await result(await rpc("tools/list", undefined, anchor)))
        .tools;
      assert.deepEqual(
        tools.map((item: { name: string }) => item.name),
        ["start_night", "next_questions", "record_answer", "round_summary"],
      );
      for (const item of tools)
        assert.ok(
          !("owner" in item.inputSchema.properties),
          `${item.name} takes an owner`,
        );
      assert.equal((await tool("start_night", {}, anchor)).week, 1);
      const first = await tool(
        "next_questions",
        { count: 2, genre: "music" },
        anchor,
      );
      const again = await tool(
        "next_questions",
        { count: 2, genre: "music" },
        anchor,
      );
      const other = await tool(
        "next_questions",
        { count: 2, genre: "music" },
        quill,
      );
      const ids = (served: { questions: { id: string }[] }) =>
        served.questions.map((item) => item.id);
      assert.equal(
        ids(first).filter((id) => ids(again).includes(id)).length,
        0,
      );
      assert.deepEqual(ids(first), ids(other));
      const marked = await tool(
        "record_answer",
        { question_id: ids(first)[0], answer: "The Beatles" },
        anchor,
      );
      assert.equal(marked.correct, true);
      const stolen = await tool(
        "record_answer",
        { question_id: ids(again)[0], answer: "x" },
        quill,
      );
      assert.match(stolen.error, /not served to this owner/);
    },
  );

  await check("the simulation repeats exactly for a seed", () => {
    const strip = (nights: ReturnType<typeof simulate>) =>
      nights.map(({ venue, host, week, rate }) => ({
        venue,
        host,
        week,
        rate,
      }));
    assert.deepEqual(strip(simulate(3, 5)), strip(simulate(3, 5)));
  });

  await check("no host ever repeats a question", () => {
    for (const seed of [1, 2, 3])
      assert.equal(
        simulate(4, seed).reduce((total, night) => total + night.repeats, 0),
        0,
      );
  });

  await check(
    "the reference host beats the forgetful one the night after it learns",
    () => {
      // Week 2 only: later weeks exhaust this small bank in a venue's liked
      // genres, and a host can no longer choose the difficulty.
      const totals = {
        forgetful: { miss: 0, unfair: 0 },
        attentive: { miss: 0, unfair: 0 },
      };
      const seeds = 20;
      for (let seed = 1; seed <= seeds; seed += 1)
        for (const night of simulate(2, seed)) {
          totals[night.host].unfair += night.unfair_questions;
          if (night.week === 2) totals[night.host].miss += night.pitch_miss;
        }
      assert.ok(
        totals.attentive.miss < totals.forgetful.miss * 0.8,
        `pitch miss ${totals.attentive.miss} vs ${totals.forgetful.miss}`,
      );
      assert.equal(totals.attentive.unfair, 0);
      assert.ok(totals.forgetful.unfair > 0);
    },
  );

  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
