/** Checks of the bank, its MCP server and the scoring: `pnpm test`. */
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
  const { registerTeams, resetScores, scoreboard, submitRound } =
    await import("../lib/scorer");
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
    assert.equal(mark(question("sc-01"), "  "), "blank");
    assert.equal(mark(question("sc-01"), "(blank)"), "blank");
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
    for (let round = 0; round < Math.ceil(QUESTIONS.length / 4); round += 1)
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
    "the MCP server lists its tools to anyone but refuses a call that names no end user",
    async () => {
      const opened = await rpc("initialize", {}, {});
      assert.equal(opened.status, 200);
      const session = opened.headers.get("mcp-session-id")!;
      const listed = await rpc("tools/list", {}, { "mcp-session-id": session });
      assert.equal((await result(listed)).tools.length, 6);
      const spoofed = await rpc(
        "tools/call",
        {
          name: "next_questions",
          arguments: { count: 1, owner: "the-anchor" },
        },
        { "mcp-session-id": session },
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
        [
          "start_night",
          "register_teams",
          "next_questions",
          "submit_round",
          "round_summary",
          "scoreboard",
        ],
      );
      for (const item of tools)
        assert.ok(
          !("owner" in item.inputSchema.properties),
          `${item.name} takes an owner`,
        );
      assert.equal((await tool("start_night", {}, anchor)).week, 1);
      await tool("start_night", {}, quill);
      const teams = await tool(
        "register_teams",
        { names: ["Quizzly Bears", "Les Quizerables"] },
        anchor,
      );
      assert.deepEqual(
        teams.teams.map((team: { regular: boolean }) => team.regular),
        [false, false],
      );
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
      const sheet = [
        {
          question_id: ids(first)[0],
          team: "Quizzly Bears",
          answer: "Beatles",
        },
        { question_id: ids(first)[0], team: "Les Quizerables", answer: "" },
      ];
      const round = await tool("submit_round", { answers: sheet }, anchor);
      assert.deepEqual(
        round.questions[0].marks.map((mark: { method: string }) => mark.method),
        ["exact", "blank"],
      );
      assert.deepEqual(round.standings[0], {
        team: "Quizzly Bears",
        points: 1,
      });
      const stolen = await tool("submit_round", { answers: sheet }, quill);
      assert.match(stolen.error, /register tonight's teams/);
    },
  );

  await check("the scorer: regulars, the season table and bad sheets", () => {
    reset();
    resetScores();
    nextWeek("a");
    registerTeams("a", ["Reds", "Blues"]);
    const [one] = nextQuestions("a", { count: 1, genre: "film" }).questions;
    const answer = (team: string, text: string) => [
      { question_id: one.id, team, answer: text },
    ];
    submitRound("a", [
      ...answer("Reds", question(one.id).answer),
      ...answer("Blues", "nope"),
    ]);
    assert.throws(
      () => submitRound("a", answer("Reds", "x")),
      /already answered/,
    );
    assert.throws(
      () => submitRound("a", answer("Greens", "x")),
      /not one of tonight's teams/,
    );
    nextWeek("a");
    assert.throws(
      () => submitRound("a", answer("Reds", "x")),
      /register tonight's teams/,
    );
    const next = registerTeams("a", ["Reds", "Greens"]);
    assert.deepEqual(
      next.teams.map((team) => team.regular),
      [true, false],
    );
    assert.throws(
      () => submitRound("a", answer("Reds", "x")),
      /not asked tonight/,
    );
    assert.deepEqual(scoreboard("a", "season").standings[0], {
      team: "Reds",
      nights: 2,
      points: 1,
    });
    assert.equal(summary("a", 1).overall.blanks, 0);
  });

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

  const evals = await import("../lib/platform-evals");
  const { POST: startEvals, GET: evalsConfig } =
    await import("../app/api/evals/route");
  const fixtures = path.join(import.meta.dirname, "fixtures", "platform-evals");

  await check("platform evals: one chain per venue and a control", () => {
    const chains = evals.plan("r1", 3);
    assert.equal(chains.length, 4);
    assert.deepEqual(
      chains[0].map((step) => [step.night, step.identity]),
      [
        ["night1-memory", "anon:sim-r1-venue-a"],
        ["night2-hosted", "anon:sim-r1-venue-a"],
      ],
    );
    assert.deepEqual(chains[3], [
      {
        run: "r1",
        venue: "control",
        night: "night2-control",
        identity: "anon:sim-r1-control",
      },
    ]);
    assert.equal(evals.plan("r1", 50).length, evals.MAX_VENUES + 1);
    assert.match(evals.newRunId(new Date(1700000000000)), /^r1700000000000$/);
  });

  await check("platform evals: the key goes only in the environment", () => {
    const key = "intro_sk_secret_value";
    const spec = evals.spawnSpec(
      evals.plan("r1", 1)[0][1],
      { runtime: "rt-1", commit: "abc123" },
      "/work/recipe-operator",
      { token: key, dpUrl: "https://dp.example" },
      { PATH: "/bin" },
    );
    assert.equal(spec.command, "introspection");
    assert.equal(spec.options.shell, false);
    assert.equal(spec.options.cwd, "/work/recipe-operator");
    assert.ok(spec.args.every((arg) => !arg.includes(key)));
    assert.deepEqual(spec.args, [
      "eval",
      "run",
      "-r",
      "rt-1",
      "--commit-sha",
      "abc123",
      "--path",
      "evals/harbor/night2-hosted",
      "--identity",
      "anon:sim-r1-venue-a",
      "--tag",
      "simulation:r1",
      "-y",
    ]);
    assert.equal(spec.options.env.INTROSPECTION_TOKEN, key);
    assert.equal(spec.options.env.INTROSPECTION_DP_URL, "https://dp.example");
    assert.equal(
      spec.options.env.INTROSPECTION_EVAL_RUNS_DIR,
      "/work/recipe-operator/eval-runs/r1/venue-a-night2-hosted",
    );
    assert.equal(
      evals.errorText(`failed with ${key}`, key),
      "failed with [redacted]",
    );
  });

  await check("platform evals: a run folder is found and read", () => {
    const passedRun = path.join(fixtures, "passed");
    const printed = `1 completed · 0 errors\nResults    ${passedRun}\n`;
    assert.equal(evals.findRunFolder(printed, "/nowhere"), passedRun);
    const root = mkdtempSync(path.join(tmpdir(), "trivia-evals-"));
    cpSync(passedRun, path.join(root, "2026-11-23__10-00-00"), {
      recursive: true,
    });
    assert.equal(
      evals.findRunFolder("no results line", root),
      path.join(root, "2026-11-23__10-00-00"),
    );
    rmSync(root, { recursive: true });

    const ok = evals.readRunFolder(passedRun);
    assert.equal(ok.reward, 1);
    assert.deepEqual(ok.checks, {
      night_started: 1,
      round_fetched: 1,
      notes_written: 1,
      notes_name_no_team: 1,
    });
    assert.equal(ok.trajectory_source, "sandbox");
    assert.match(ok.notes ?? "", /Difficulty: 3/);
    assert.equal(ok.error, null);

    const failed = evals.readRunFolder(path.join(fixtures, "failed"));
    assert.equal(failed.reward, null);
    assert.deepEqual(failed.checks, {});
    assert.equal(failed.error, "the trial sandbox did not start");
  });

  await check("platform evals: the route refuses without a key", async () => {
    const local = (init: RequestInit = {}) =>
      new Request("http://localhost:3500/api/evals", {
        method: "POST",
        body: "{}",
        ...init,
      });
    delete process.env.TRIVIA_EVAL_KEY_FILE;
    let response: Response = await startEvals(local());
    assert.equal(response.status, 403);
    assert.match((await response.json()).how_to, /--secret-file/);
    process.env.TRIVIA_EVAL_KEY_FILE = "no-such-file.key";
    response = await startEvals(local());
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /does not exist/);
    delete process.env.TRIVIA_EVAL_KEY_FILE;
    response = await startEvals(
      local({ headers: { "cf-connecting-ip": "203.0.113.7" } }),
    );
    assert.equal(response.status, 403);
    response = await evalsConfig(
      new Request("https://abc.trycloudflare.com/api/evals"),
    );
    assert.equal(response.status, 403);
  });

  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
