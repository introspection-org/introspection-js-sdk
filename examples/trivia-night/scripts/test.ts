/** Checks of the bank, its MCP server, the scoring and the platform evals: `pnpm test`. */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
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

  const evals = await import("../lib/platform-evals");
  const memory = await import("../lib/memory-measures");
  const { POST: startEvals } = await import("../app/api/evals/route");
  const writeRunFolder = (
    folder: string,
    files: Record<string, string | object>,
  ) => {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(folder, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        typeof content === "string" ? content : JSON.stringify(content),
      );
    }
    return folder;
  };
  const passedTrial = "harbor/night1-memory__Ab12Cd";
  const passedFiles = {
    "run.json": {
      schema_version: 11,
      id: "2026-11-23__10-00-00",
      runner: "harbor",
      suite_path: "evals/harbor/night1-memory",
      status: "completed",
      candidate: { runtime: "00000000-0000-7000-8000-000000000001" },
      result: {
        metrics: { cases_passed: 1.0, cases_total: 1.0, reward: 1.0 },
        completion_reason: "completed",
        diagnostics: [],
      },
      started_at: "1795400000",
      completed_at: "1795400180",
    },
    [`${passedTrial}/result.json`]: {
      task_name: "trivia-host/night1-memory",
      trial_name: "night1-memory__Ab12Cd",
      agent_result: { metadata: { trajectory_source: "sandbox" } },
      verifier_result: { rewards: { reward: 1.0 } },
      exception_info: null,
    },
    [`${passedTrial}/verifier/test-stdout.txt`]: JSON.stringify(
      {
        reward: 1,
        night_started: 1,
        round_fetched: 1,
        notes_written: 1,
        notes_name_no_team: 1,
        notes: "# The venue\n\n- Country: UK\n",
      },
      null,
      2,
    ),
    [`${passedTrial}/artifacts/memories/MEMORY.md`]:
      "# The venue\n\n- Country: UK\n- Likes: music, film\n- Difficulty: 3\n",
  };
  const failedFiles = {
    "run.json": {
      schema_version: 11,
      id: "2026-11-23__10-00-01",
      runner: "harbor",
      suite_path: "evals/harbor/night2-control",
      status: "completed",
      result: {
        metrics: { cases_incomplete: 1.0, cases_total: 1.0 },
        completion_reason: "completed_with_errors",
        diagnostics: [
          {
            trial: "night2-control__Zz99Yy",
            kind: "RuntimeError",
            message: "the trial sandbox did not start",
          },
        ],
      },
    },
    "harbor/night2-control__Zz99Yy/result.json": {
      task_name: "trivia-host/night2-control",
      trial_name: "night2-control__Zz99Yy",
      agent_result: null,
      verifier_result: null,
      exception_info: {
        exception_type: "RuntimeError",
        exception_message: "the trial sandbox did not start\n",
      },
    },
  };

  await check("platform evals: each venue's four night 2s", () => {
    const profiles = [
      { slug: "melbourne", label: "Melbourne (AU)", region: "au" },
      { slug: "leeds", label: "Leeds (UK)", region: "uk" },
    ];
    const chains = evals.plan("r1", 3, profiles);
    // Three chains per venue, then one wrong-notes chain per venue.
    assert.equal(chains.length, 12);
    assert.equal(chains.flat().length, 18);
    assert.deepEqual(
      chains[0].map((step) => [
        step.night,
        step.task,
        step.identity,
        step.variant,
      ]),
      [
        [
          "night1-memory",
          "night1-melbourne",
          "anon:sim-r1-melbourne",
          undefined,
        ],
        ["night2-hosted", "night2-melbourne", "anon:sim-r1-melbourne", "with"],
      ],
    );
    assert.deepEqual(chains[1], [
      {
        run: "r1",
        venue: "melbourne",
        venue_label: "Melbourne (AU)",
        night: "night2-fresh",
        task: "night2-melbourne",
        identity: "anon:sim-r1-melbourne-fresh",
        variant: "without",
      },
    ]);
    // Perfect notes: night 0 seeds the true notes, then night 2 reads them, on their own identity.
    assert.deepEqual(
      chains[2].map((step) => [step.night, step.task, step.identity]),
      [
        ["night0-seed", "night0-melbourne", "anon:sim-r1-melbourne-perfect"],
        ["night2-perfect", "night2-melbourne", "anon:sim-r1-melbourne-perfect"],
      ],
    );
    assert.equal(chains[3][0].task, "night1-leeds");
    // More venues than profiles: the third plays Melbourne again, as its own identity.
    assert.deepEqual(
      [chains[6][1].venue, chains[6][1].venue_label, chains[6][1].task],
      ["melbourne-2", "Melbourne (AU) #2", "night2-melbourne"],
    );
    // Wrong notes: Melbourne's night 2 runs as Leeds's customer, after Leeds's night 1 and 2.
    const wrong = chains.slice(9).map(([step]) => step);
    assert.deepEqual(
      wrong.map((step) => [step.venue, step.donor, step.identity]),
      [
        ["melbourne", "leeds", "anon:sim-r1-leeds"],
        ["leeds", "melbourne-2", "anon:sim-r1-melbourne-2"],
        ["melbourne-2", "leeds", "anon:sim-r1-leeds"],
      ],
    );
    assert.deepEqual(wrong[0].after, [
      "leeds/night1-memory",
      "leeds/night2-hosted",
    ]);
    assert.equal(wrong[0].task, "night2-melbourne");
    assert.equal(wrong[0].variant, "wrong");
    const keys = new Set(chains.flat().map(evals.stepKey));
    for (const step of wrong) {
      assert.notEqual(step.donor, step.venue);
      assert.ok(step.after?.every((key) => keys.has(key)));
      assert.equal(step.after?.[0], `${step.donor}/night1-memory`);
    }
    assert.ok(
      chains.every((chain) => chain.every((s) => s.task !== "night2-control")),
    );
    // One venue has no other pub, so no wrong notes.
    assert.ok(
      evals
        .plan("r1", 1, profiles)
        .flat()
        .every((step) => step.night !== "night2-wrong"),
    );
    const all = evals.plan("r1", 50);
    assert.equal(all.length, evals.MAX_VENUES * 4);
    assert.equal(all.flat().length, evals.MAX_VENUES * evals.TRIALS_PER_VENUE);
    assert.ok(evals.MAX_VENUES >= 6);
    // Each development donor is abroad and shares no favourite genre.
    const venues = evals.PUB_SETS.development;
    venues.forEach((venue, index) => {
      const donor = venues[evals.donorOf(index, venues)!];
      assert.notEqual(donor.region, venue.region, venue.slug);
      assert.ok(
        !donor.liked?.some((g) => venue.liked?.includes(g)),
        venue.slug,
      );
    });
    assert.equal(evals.donorOf(0, venues.slice(0, 1)), null);
    // A crowd of 3 or 8 plays the suffixed tasks; every planned task is on disk.
    assert.deepEqual(
      evals
        .plan("r1", 1, profiles, 8)
        .flat()
        .map((step) => step.task),
      [
        "night1-melbourne-t8",
        "night2-melbourne-t8",
        "night2-melbourne-t8",
        "night0-melbourne",
        "night2-melbourne-t8",
      ],
    );
    assert.equal(
      evals.plan("r1", 1, profiles, 3)[1][0].task,
      "night2-melbourne-t3",
    );
    // The tasks are generated, not committed: write them where the test can see them.
    const generated = mkdtempSync(path.join(tmpdir(), "trivia-harbor-"));
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.join(import.meta.dirname, "../recipe-operator/evals/venues.mjs"),
        generated,
      ],
      { stdio: "ignore" },
    );
    for (const pubs of ["development", "heldout"] as const)
      for (const size of evals.TEAM_SIZES)
        for (const step of evals
          .plan(
            "r1",
            evals.MAX_VENUES_BY_PUBS[pubs],
            evals.PUB_SETS[pubs],
            size,
          )
          .flat())
          assert.ok(
            existsSync(path.join(generated, step.task, "task.toml")),
            step.task,
          );
    assert.ok(evals.isPubs("heldout") && !evals.isPubs("held-out"));
    assert.ok(
      evals.isTeamSize(5) && !evals.isTeamSize(4) && !evals.isTeamSize("5"),
    );
    assert.match(evals.newRunId(new Date(1700000000000)), /^r1700000000000$/);
  });

  const venuesGen = await import("../recipe-operator/evals/venues.mjs");
  await check("platform evals: the team sizes match the generator's", () => {
    assert.deepEqual([...evals.TEAM_SIZES], venuesGen.TEAM_SIZES);
    assert.equal(evals.DEFAULT_TEAMS, venuesGen.DEFAULT_TEAMS);
    for (const size of evals.TEAM_SIZES)
      assert.equal(
        evals.taskName(2, "leeds", size),
        venuesGen.taskName(2, "leeds", size),
      );
  });
  await check("venue tasks: a night-1 and night-2 task per profile", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "trivia-venues-"));
    try {
      const harbor = path.join(dir, "harbor");
      const manifest = path.join(dir, "venues.json");
      const profile = (
        id: string,
        city: string,
        region: "au" | "uk" | "us",
      ) => ({
        id,
        pub: `The ${city} Arms`,
        city,
        region,
        teams: [`${city} Owls`, "The Quizzards", "Third Team"],
        stated: ["film", "music"],
      });
      const venues = venuesGen.writeVenues(harbor, manifest, [
        { ...profile("au-a", "Melbourne", "au"), level: 3.8 },
        profile("us-b", "New York", "us"),
      ]);
      assert.equal(
        JSON.parse(
          readFileSync(
            path.join(harbor, "night1-melbourne/tests/expected.json"),
            "utf8",
          ),
        ).target_difficulty,
        4,
      );
      assert.deepEqual(
        venues.map((v) => [v.slug, v.label]),
        [
          ["melbourne", "Melbourne (AU)"],
          ["new-york", "New York (US)"],
        ],
      );
      assert.deepEqual(JSON.parse(readFileSync(manifest, "utf8")), venues);
      const read = (file: string) =>
        readFileSync(path.join(harbor, file), "utf8");
      const night1 = read("night1-melbourne/instruction.md");
      assert.match(night1, /We're in Melbourne, in Australia/);
      assert.match(
        night1,
        /Three teams tonight: Melbourne Owls, The Quizzards and Third Team\./,
      );
      // Night 1 hints at one favourite only; the host finds the rest from round_summary.
      assert.match(night1, /this crowd loves film\./);
      assert.doesNotMatch(night1, /music/);
      assert.match(night1, /six short rounds of four questions/);
      assert.match(night1, /check round_summary/);
      assert.match(
        read("night2-new-york/instruction.md"),
        /Same three teams as last week here in New York: New York Owls, The Quizzards and Third Team\./,
      );
      assert.deepEqual(
        JSON.parse(read("night2-new-york/tests/expected.json")),
        {
          venue: "us-b",
          region: "us",
          teams: ["New York Owls", "The Quizzards", "Third Team"],
          night1_teams: ["New York Owls", "The Quizzards", "Third Team"],
          liked: ["film", "music"],
          disliked: [],
          hinted: ["film"],
        },
      );
      // Night 0 seeds the true notes, once for every crowd size, with no model writing them.
      const seeded = read("night0-melbourne/tests/notes.md");
      assert.equal(seeded, venuesGen.perfectNotes(venues[0]));
      assert.match(seeded, /Country: Australia \(Melbourne\)/);
      assert.match(seeded, /start next night at 4/);
      assert.match(read("night0-melbourne/instruction.md"), /no quiz tonight/);
      assert.ok(read("night0-melbourne/solution/solve.sh").includes(seeded));
      assert.ok(!existsSync(path.join(harbor, "night0-melbourne-t8")));
      assert.equal(
        memory.notesAccuracy(seeded, {
          region: "au",
          liked: venues[0].liked,
          disliked: venues[0].disliked,
          target_difficulty: 4,
        }),
        1,
      );
      assert.deepEqual(
        venuesGen.venueOf({
          ...profile("au-c", "Hobart", "au"),
          enjoy: {
            music: 0.85,
            film: 0.3,
            sport: 0.5,
            science: 0.2,
            history: 0.72,
            geography: 0.45,
          },
        }),
        {
          slug: "hobart",
          label: "Hobart (AU)",
          profile: "au-c",
          pub: "The Hobart Arms",
          city: "Hobart",
          region: "au",
          teams: ["Hobart Owls", "The Quizzards", "Third Team"],
          night2_teams: Object.fromEntries(
            ["3", "5", "8"].map((n) => [
              n,
              ["Hobart Owls", "The Quizzards", "Third Team"],
            ]),
          ),
          liked: ["music", "history"],
          disliked: ["science"],
          hinted: ["film", "music"].slice(0, 1),
        },
      );
      assert.match(
        read("night2-new-york/environment/docker-compose.yaml"),
        /EVAL_SIMULATE_SCENARIO: crowd-us-b/,
      );
      assert.match(
        read("night2-new-york/environment/docker-compose.yaml"),
        /EVAL_SIMULATE_TEAMS: "5"/,
      );
      assert.match(
        read("night1-melbourne-t3/environment/docker-compose.yaml"),
        /EVAL_SIMULATE_TEAMS: "3"/,
      );
      assert.match(
        read("night2-melbourne-t8/task.toml"),
        /name = "trivia-host\/night2-melbourne-t8"/,
      );
      assert.match(
        read("night1-melbourne/task.toml"),
        /name = "trivia-host\/night1-melbourne"/,
      );
      assert.match(
        read("night2-melbourne/tests/check.mjs"),
        /reward = \(measures\.in_band \?\? 0\) >= 0\.5/,
      );
      for (const file of ["tests/test.sh", "solution/solve.sh"])
        assert.ok(
          statSync(path.join(harbor, "night1-melbourne", file)).mode & 0o100,
        );
      // A venue the profiles no longer list loses its tasks.
      venuesGen.writeVenues(harbor, manifest, [
        profile("au-a", "Melbourne", "au"),
      ]);
      assert.ok(!existsSync(path.join(harbor, "night1-new-york")));
      assert.ok(!existsSync(path.join(harbor, "night2-new-york-t8")));
      assert.ok(existsSync(path.join(harbor, "night2-melbourne")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await check("platform evals: the key goes only in the environment", () => {
    const key = "intro_sk_secret_value";
    const spec = evals.spawnSpec(
      evals.plan("r1", 1, [
        { slug: "sydney", label: "Sydney (AU)", region: "au" },
      ])[0][1],
      { runtime: "rt-1", commit: "abc123" },
      "/work/recipe-operator",
      { token: key, apiBaseUrl: "http://localhost:8000" },
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
      "evals/harbor/night2-sydney",
      "--identity",
      "anon:sim-r1-sydney",
      "--tag",
      "simulation:r1",
      "-y",
    ]);
    assert.equal(spec.options.env.INTROSPECTION_TOKEN, key);
    assert.equal(
      spec.options.env.INTROSPECTION_API_BASE_URL,
      "http://localhost:8000",
    );
    assert.equal(
      spec.options.env.INTROSPECTION_EVAL_RUNS_DIR,
      "/work/recipe-operator/eval-runs/r1/sydney-night2-hosted",
    );
    assert.equal(
      evals.errorText(`failed with ${key}`, key),
      "failed with [redacted]",
    );
    assert.equal(
      evals.errorText(
        [
          "  Harbor adapter native, environment introspection_harbor.task_environment:IntrospectionEnvironment",
          "Error: The installed Introspection Harbor adapter is not compatible with this CLI.",
          "",
          "Run:",
          "  introspection setup --target harbor",
        ].join("\n"),
        key,
      ),
      "Error: The installed Introspection Harbor adapter is not compatible with this CLI.\n\nRun:\n  introspection setup --target harbor",
    );
  });

  await check(
    "platform evals: each round's questions and team marks are read from the verifier",
    () => {
      const rounds = evals.parseRounds([
        {
          round: 1,
          genre: "film",
          difficulty: 2,
          correct_rate: 0.6,
          questions: [
            {
              text: "Who directed Jaws?",
              answer: "Steven Spielberg",
              marks: [
                { team: "Quizzly Bears", answer: "", correct: true },
                { team: "The Blow-Ins", answer: "", correct: false },
                { answer: "", correct: true },
              ],
            },
            {
              text: "Which film won Best Picture in 1998?",
              options: ["Titanic", "Fargo", 3, "Good Will Hunting"],
              answer: "Titanic",
              marks: [],
            },
            "not a question",
          ],
        },
        "not a round",
        { genre: "music", questions: "none" },
      ]);
      assert.equal(rounds.length, 2);
      assert.deepEqual(rounds[0].questions[0].marks, [
        { team: "Quizzly Bears", correct: true },
        { team: "The Blow-Ins", correct: false },
      ]);
      assert.deepEqual(rounds[0].questions[1].options, [
        "Titanic",
        "Fargo",
        "Good Will Hunting",
      ]);
      assert.equal(rounds[0].questions.length, 2);
      assert.deepEqual(rounds[1], {
        round: 2,
        genre: "music",
        difficulty: 0,
        correct_rate: null,
        questions: [],
      });
      assert.deepEqual(evals.parseRounds(undefined), []);
    },
  );

  await check("platform evals: a run folder is found and read", () => {
    const base = mkdtempSync(path.join(tmpdir(), "trivia-evals-"));
    const passedRun = writeRunFolder(path.join(base, "passed"), passedFiles);
    const printed = `1 completed · 0 errors\nResults    ${passedRun}\n`;
    assert.equal(evals.findRunFolder(printed, "/nowhere"), passedRun);
    const root = path.join(base, "runs");
    writeRunFolder(path.join(root, "2026-11-23__10-00-00"), passedFiles);
    assert.equal(
      evals.findRunFolder("no results line", root),
      path.join(root, "2026-11-23__10-00-00"),
    );

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
    assert.deepEqual(ok.fetches, []);
    assert.deepEqual(ok.rounds, []);
    assert.equal(ok.error, null);

    const failed = evals.readRunFolder(
      writeRunFolder(path.join(base, "failed"), failedFiles),
    );
    assert.equal(failed.reward, null);
    assert.deepEqual(failed.checks, {});
    assert.equal(failed.error, "the trial sandbox did not start");
    rmSync(base, { recursive: true });
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
  });

  const trial = await import("../lib/trial-steps");
  const notes = "# Venue notes\n\n- Country: UK\n- Difficulty: 3\n";
  const kinds = (events: { type: string }[]) => events.map((e) => e.type);

  await check(
    "trial steps: a finished trajectory becomes the page's events",
    () => {
      const base = mkdtempSync(path.join(tmpdir(), "trivia-trajectory-"));
      const steps = [
        { step_id: 1, source: "system", message: "You are the trivia host." },
        { step_id: 2, source: "user", message: "Evening!" },
        {
          step_id: 3,
          source: "agent",
          message: "",
          tool_calls: [
            {
              tool_call_id: "toolu_recipe_memory_read",
              function_name: "read",
              arguments: { path: "/workspace/memories/MEMORY.md" },
            },
            {
              tool_call_id: "t1",
              function_name: "mcp_trivia-bank_next_questions_520f9420fe",
              arguments: { count: 8, genre: "history" },
            },
          ],
          observation: {
            results: [
              { source_call_id: "toolu_recipe_memory_read", content: notes },
              { source_call_id: "t1", content: '{"questions":[]}' },
            ],
          },
        },
        {
          step_id: 4,
          source: "agent",
          message: "Now the notes.",
          tool_calls: [
            {
              tool_call_id: "t2",
              function_name: "edit",
              arguments: {
                path: "/workspace/memories/MEMORY.md",
                oldText: "Difficulty: 3",
                newText: "Difficulty: 4",
              },
            },
          ],
          observation: { results: [{ source_call_id: "t2", content: "ok" }] },
        },
        {
          step_id: 5,
          source: "agent",
          message: "Tonight: history at 3. " + "x".repeat(2400),
        },
      ];
      writeRunFolder(base, {
        "run.json": {},
        "harbor/night2-hosted__getFCyA/result.json": {},
        "harbor/night2-hosted__getFCyA/agent/trajectory.json": {
          schema_version: "ATIF-v1.7",
          steps,
        },
      });
      const file = trial.trajectoryFile(base);
      assert.equal(
        file,
        path.join(base, "harbor/night2-hosted__getFCyA/agent/trajectory.json"),
      );
      const events = trial.trajectoryEvents(file!);
      assert.deepEqual(kinds(events), [
        "memory.read",
        "bank.served",
        "memory.written",
        "host.planned",
      ]);
      assert.equal(events[0].data.file, notes);
      assert.equal((events[3].data.file as string).length, 2000);

      assert.deepEqual(events[1].data, {
        server: "trivia-bank",
        tool: "next_questions",
        arguments: { count: 8, genre: "history" },
      });
      assert.match(events[1].summary, /genre history, 8 questions/);

      // A first visit's read of notes that don't exist yet is no error.
      const missing =
        "ENOENT: no such file or directory, access '/workspace/memories/MEMORY.md'";
      for (const result of [missing, ""])
        assert.deepEqual(
          trial.toolCallEvent(
            "r1",
            "read",
            { path: "/workspace/memories/MEMORY.md" },
            result,
            result !== "",
          ),
          {
            key: "tool:r1",
            type: "memory.read",
            summary: "Loading memory · none yet — first visit",
            data: {
              path: "/workspace/memories/MEMORY.md",
              file: "",
              first_visit: true,
            },
          },
        );
      // Other tool errors still show, shortened to one line.
      const failed = trial.toolCallEvent(
        "t9",
        "mcp_trivia-bank_next_questions_520f9420fe",
        { genre: "history" },
        "Error: unknown region\nstack…",
        true,
      );
      assert.equal(failed?.data.error, "Error: unknown region");
      rmSync(base, { recursive: true });
    },
  );

  const display = await import("../lib/display");

  await check("notes previews and event text drop markdown", () => {
    assert.equal(
      display.plainLine("- **Country:** UK. Use region `uk` only."),
      "Country: UK. Use region uk only.",
    );
    assert.equal(
      display.notesPreview(
        "# Venue\n\n- **Crowd:** loves music and hates sport",
      ),
      "Crowd: loves music and hates sport",
    );
    const long = display.truncateWords(
      "the crowd liked music so it's a safe opener for next week",
      30,
    );
    assert.equal(long, "the crowd liked music so it's…");
    assert.ok(long.length <= 30);
    assert.equal(display.truncateWords("short", 30), "short");
    assert.equal(
      display.firstSentences(
        "**Before I fetch anything**, which country is the venue in? Then I'll pick rounds. Third.",
      ),
      "Before I fetch anything, which country is the venue in? Then I'll pick rounds.",
    );
    assert.equal(
      display.roundLabel({ genre: "history", region: "uk", difficulty: 3 }),
      "history · uk · diff 3",
    );
  });

  await check("event labels are short", () => {
    assert.equal(display.kindLabel("bank.served"), "tool");
    assert.equal(display.kindLabel("bank.marked"), "tool");
    assert.equal(display.kindLabel("memory.read"), "read");
    assert.equal(display.kindLabel("memory.written"), "write");
    assert.equal(display.kindLabel("host.planned"), "plan");
    assert.equal(
      display.toolLine("trivia-bank", "next_questions", {
        genre: "music",
        difficulty: 3,
        region: "uk",
        count: 8,
      }),
      "trivia-bank · next_questions · music · difficulty 3 · uk · 8 questions",
    );
    assert.equal(
      display.toolLine("trivia-bank", "start_night", {}),
      "trivia-bank · start_night",
    );
    assert.equal(
      display.toolLine("trivia-bank", "register_teams", { names: ["a", "b"] }),
      "trivia-bank · register_teams · 2 teams",
    );
    assert.equal(
      display.targetLabel("trivia-host", "e328209abcdef0123"),
      "trivia-host @ e328209",
    );
    assert.equal(
      display.targetLabel("0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "e328209ab"),
      "0199a1b2 @ e328209",
    );
    assert.equal(
      display.targetLabel(
        "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
        "e328209ab",
        "trivia-host",
      ),
      "trivia-host @ e328209",
    );
  });

  await check(
    "notes become fact chips, marking what changed since night 1",
    () => {
      const night1 = [
        "# Venue notes",
        "- **Country:** UK (Manchester). Use region `uk` or `global` only.",
        "- **Starting difficulty:** 3. Raise it if they ace a round.",
        "- **Notes on pace:** keep it brisk.",
        "- **Genres:** played two rounds (music, then history) tonight.",
      ].join("\n");
      assert.deepEqual(
        display.factChips(night1).map((chip) => chip.text),
        ["UK", "diff 3", "played: music, history"],
      );
      const night2 = night1.replace("difficulty:** 3", "difficulty:** 4");
      const chips = display.factChips(night2, night1);
      assert.deepEqual(
        chips.map((chip) => [chip.text, chip.changed]),
        [
          ["UK", false],
          ["diff 3→4", true],
          ["played: music, history", false],
        ],
      );
      assert.deepEqual(
        display.factChips("Just a sentence about the room."),
        [],
      );
    },
  );

  await check(
    "verifier rows: yes/no checks tick, measures read in words",
    () => {
      const fetches = [
        { genre: "sport", count: 5, correct_rate: 0.68 },
        { genre: "history", count: 5, correct_rate: 0.41 },
      ];
      const line = (key: string, value: number, f = fetches) =>
        memory.checkLine(key, value, f);
      assert.deepEqual(line("fetched_a_round", 1), {
        key: "fetched_a_round",
        text: "Quiz run",
        pass: true,
      });
      assert.equal(line("notes_kept", 0).pass, false);
      assert.equal(
        line("right_region", 1).text,
        "Questions from the right region",
      );
      assert.deepEqual(line("in_band", 0.5), {
        key: "in_band",
        text: "Rounds pitched right: 1 of 2 (68%, 41% right)",
      });
      assert.equal(line("in_band", 0.5, []).text, "Rounds pitched right: 50%");
      assert.equal(
        line("favourite_genre", 1).text,
        "Rounds in favourite genres: 2 of 2",
      );
      assert.equal(
        line("close_finish", 0.2).text,
        "How close the finish was: within 2 points",
      );
      assert.equal(
        line("close_finish", 0.2, []).text,
        "How close the finish was: 20% gap",
      );
      assert.equal(line("some_new_key", 3).text, "Some new key: 3");
      assert.equal(line("in_band", 0.5).pass, undefined);
    },
  );

  const summaryRules = await import("../lib/summary");
  await check("summary: each arm's reason against no notes, by rule", () => {
    const stats = (good: number, loved: number, firstHits: number) => ({
      good,
      loved,
      firstHits,
    });
    // Model notes win on taste, not level.
    const model = {
      pubs: 11,
      arm: stats(0.33, 0.61, 4),
      none: stats(0.17, 0.33, 4),
    };
    assert.equal(
      summaryRules.modelWhy(model),
      "Model notes beat no notes (0.33 vs 0.17) because the host remembered what this crowd likes: loved genres in 61% of rounds vs 33%. It opened at the right level at 4 of 11 pubs, so pitch didn't help.",
    );
    // A difference under one round per pub is noise, and so is anything under 3 pubs.
    assert.match(
      summaryRules.modelWhy({ ...model, arm: stats(0.2, 0.4, 4) }) ?? "",
      /^Model notes and no notes are within noise on good rounds \(0\.20 vs 0\.17\)\.$/,
    );
    assert.match(
      summaryRules.modelWhy({ ...model, pubs: 2 }) ?? "",
      /^With 2 pubs this is within noise/,
    );
    assert.equal(summaryRules.modelWhy(null), null);
    // Other notes: taste doesn't transfer, the level may.
    assert.equal(
      summaryRules.otherWhy({
        pubs: 11,
        arm: stats(0.05, 0.2, 7),
        none: stats(0.17, 0.33, 4),
      }),
      "Other notes did worse than no notes (0.05 vs 0.17): another pub's tastes don't transfer, though their opening level carried over at 7 of 11 pubs.",
    );
    // True notes, the ceiling, with how far model notes reached.
    assert.equal(
      summaryRules.trueWhy(
        { pubs: 11, arm: stats(0.41, 0.68, 6), none: stats(0.17, 0.33, 4) },
        model,
      ),
      "True notes, the ceiling: 0.41 good rounds vs 0.17 with no notes; model notes reached 0.33.",
    );
  });

  await check("summary: the one next step, by rule", () => {
    const base = {
      pubSet: "development" as const,
      pubsRun: 11,
      developmentPubs: 11,
      heldoutPubs: 20,
      intervalIncludesZero: false,
      missingNights: 0,
      gatePasses: true,
      costPerTrial: 0.086,
      trialsPerPub: 6,
    };
    assert.equal(
      summaryRules.nextStep(base),
      "Ready for the held-out run (20 pubs, estimated cost $10.32): it is used once, for the final result.",
    );
    assert.equal(
      summaryRules.nextStep({ ...base, pubsRun: 3 }),
      "Run all 11 development pubs to get an interval (estimated cost $5.68).",
    );
    assert.match(
      summaryRules.nextStep({ ...base, intervalIncludesZero: true }),
      /^Run all 11 development pubs/,
    );
    assert.match(
      summaryRules.nextStep({ ...base, missingNights: 2 }),
      /^Rerun to fill the missing nights: 2 pubs lost a night 2\.$/,
    );
    assert.match(
      summaryRules.nextStep({ ...base, gatePasses: false }),
      /^The world check failed/,
    );
    assert.match(
      summaryRules.nextStep({ ...base, pubSet: "heldout", pubsRun: 20 }),
      /^This is the held-out result/,
    );
  });

  await check("memory measures: night 1, night 2 with and without", () => {
    const tastes = {
      region: "uk",
      liked: ["sport", "history"],
      disliked: ["science"],
      target_difficulty: 2,
    };
    const night1Notes = "- **Country:** UK\n- Loves sport and history.";
    const fetches = [
      {
        genre: "sport",
        difficulty: 2,
        region: "uk",
        count: 5,
        correct_rate: 0.7,
      },
      {
        genre: "film",
        difficulty: 3,
        region: "global",
        count: 5,
        correct_rate: 0.3,
      },
    ];
    // Night 1: notes, and the crowd's measures derived from its rounds.
    assert.deepEqual(
      memory.measuresOf("night1-memory", {
        checks: { notes_written: 1 },
        notes: night1Notes,
        fetches,
        tastes,
      }),
      {
        notes_written: 1,
        // Favourites, dislikes and country right; no starting difficulty named.
        notes_accuracy: 0.75,
        good_rounds: 0.5,
        pitch_miss: 0.2,
        in_band: 0.5,
        favourite_genre: 0.5,
        // The first round (70% right) landed in the band.
        first_round_in_band: 1,
        right_region: 1,
      },
    );
    // Night 2 with memory: the verifier's numbers win, and notes_kept applies.
    const verifier = {
      fetched_a_round: 1,
      notes_kept: 1,
      good_rounds: 1,
      pitch_miss: 0.05,
      in_band: 1,
      close_finish: 0.1,
      favourite_genre: 1,
      right_region: 1,
    };
    assert.deepEqual(
      memory.measuresOf("night2-hosted", {
        checks: verifier,
        fetches,
        tastes,
        night1Notes,
      }),
      {
        good_rounds: 1,
        pitch_miss: 0.05,
        in_band: 1,
        close_finish: 0.1,
        favourite_genre: 1,
        // Not printed by this (older) verifier, so derived from the first round.
        first_round_in_band: 1,
        right_region: 1,
        notes_kept: 1,
      },
    );
    // Without memory: no notes to keep, and a foreign round fails the region.
    assert.deepEqual(
      memory.measuresOf("night2-fresh", {
        checks: { fetched_a_round: 1, notes_kept: 1 },
        fetches: [
          {
            genre: "science",
            region: "us+global",
            count: 5,
            correct_rate: 0.1,
          },
        ],
        tastes,
      }),
      {
        good_rounds: 0,
        pitch_miss: 0.55,
        in_band: 0,
        favourite_genre: 0,
        // A first round 10% right missed the band.
        first_round_in_band: 0,
        right_region: 0,
      },
    );
    // No round fetched: nothing about the crowd can be told.
    assert.deepEqual(
      memory.measuresOf("night2-fresh", {
        checks: { fetched_a_round: 0 },
        fetches: [],
        tastes,
      }),
      {},
    );
    for (const m of Object.values(memory.MEASURES))
      assert.ok(["higher", "lower"].includes(m.better));
  });

  await check("notes accuracy: graded against the crowd's true tastes", () => {
    // Melbourne loves science (hinted on night 1) and music (to be learned); bored by sport and film; level 3.
    const melbourne = {
      region: "au",
      liked: ["science", "music"],
      disliked: ["sport", "film"],
      hinted: ["science"],
      target_difficulty: 3,
    };
    const good = [
      "# Venue notes",
      "- Country: Australia (Melbourne). Use region `au` (or `global`).",
      "- Genres: the trivia master says they love science (not yet confirmed). Music went down well too, so the crowd likes music as well.",
      "- Sport fell flat: they don't enjoy it.",
      "- Difficulty: start next night at 3.",
    ].join("\n");
    assert.deepEqual(memory.likedInNotes(good).sort(), ["music", "science"]);
    assert.equal(memory.startingLevel(good), 3);
    assert.equal(memory.notesAccuracy(good, melbourne), 1);
    // The crowd's best decade is reported, not scored.
    const eras = { ...melbourne, best_decades: ["1990s", "2000s"] };
    assert.equal(memory.notesAccuracy(good, eras), 1);
    assert.ok(memory.namesDecade("They know the 90s best.", "1990s"));
    assert.ok(!memory.namesDecade("Not the 1990s, though.", "1990s"));
    // Only the hinted favourite: the one thing night 1 was told, so it earns nothing for genres.
    const hintOnly = good.replace(
      /Music went down well too, so the crowd likes music as well\./,
      "",
    );
    assert.equal(memory.notesAccuracy(hintOnly, melbourne), 0.75);
    // Another pub's notes (Leeds: UK, loves history and sport, level 2): low.
    const leeds = [
      "# Venue notes",
      "- Country: UK (Leeds). Use region `uk` (or global).",
      "- Crowd loves history and sport. Keep science rare.",
      "- Start next night at difficulty 1.",
    ].join("\n");
    assert.deepEqual(memory.likedInNotes(leeds).sort(), ["history", "sport"]);
    assert.equal(memory.notesAccuracy(leeds, melbourne), 0);
    // Negation and parentheses don't count as liked; a capital US is a country, "us" is not.
    assert.deepEqual(
      memory.likedInNotes(
        "- They don't like film (but loves sport).\n- Loves music, but not science.",
      ),
      ["music"],
    );
    assert.equal(
      memory.notesAccuracy("Tell us more. Region `au`.", { region: "au" }),
      0.75,
    );
    // night1Measures grades the notes when the venue's tastes are known.
    assert.equal(
      memory.measuresOf("night1-memory", {
        checks: { notes_written: 1 },
        notes: good,
        tastes: melbourne,
      }).notes_accuracy,
      1,
    );
  });

  const experiment = await import("../lib/experiment");
  await check(
    "experiment: sign test, Holm, ordering and the validity gate",
    () => {
      // 5 of 6 better: P(X <= 1) = 7/64, so p = 14/64.
      assert.deepEqual(experiment.signTest([1, 1, 1, 1, 1, -1]), {
        positive: 5,
        negative: 1,
        p: 14 / 64,
      });
      // 8 of 8 better, ties dropped: p = 2/256.
      assert.equal(experiment.signTest([1, 1, 1, 1, 0, 1, 1, 1, 1]).p, 2 / 256);
      assert.equal(experiment.signTest([0, 0]).p, 1);
      assert.equal(experiment.signTest([1, -1]).p, 1);
      // Holm over 0.01, 0.04, 0.03: 0.01×3, then max(0.03, 0.03×2), then max(0.06, 0.04×1).
      const adjusted = experiment.holm([0.01, 0.04, 0.03]);
      assert.deepEqual(
        adjusted.map((p) => Math.round(p * 1e6) / 1e6),
        [0.03, 0.06, 0.06],
      );
      assert.deepEqual(experiment.holm([0.5, 0.9]), [1, 1]);
      assert.deepEqual(
        experiment.ordering({
          perfect: 0.8,
          right: 0.6,
          none: 0.4,
          wrong: 0.2,
        }),
        {
          perfectAtLeastRight: true,
          rightOverNone: true,
          noneOverWrong: true,
          holds: true,
        },
      );
      const broken = experiment.ordering({ right: 0.6, none: 0.4, wrong: 0.5 });
      assert.equal(broken.noneOverWrong, false);
      assert.equal(broken.holds, false);
      assert.equal(
        experiment.ordering({ perfect: 0.5, right: 0.6, none: 0.4, wrong: 0.2 })
          .holds,
        false,
      );
      // Differences 0.2, 0.3, 0.25: mean 0.25, sd 0.05, t(2) 4.303, half-width 0.1242.
      const gate = experiment.validityGate([
        { perfect: 0.6, none: 0.4 },
        { perfect: 0.7, none: 0.4 },
        { perfect: 0.75, none: 0.5 },
      ])!;
      assert.equal(gate.pubs, 3);
      assert.ok(Math.abs(gate.difference - 0.25) < 1e-9);
      assert.ok(Math.abs(gate.interval![0] - 0.1258) < 1e-3);
      assert.ok(Math.abs(gate.interval![1] - 0.3742) < 1e-3);
      assert.equal(gate.passes, true);
      // Too small a gap fails, however steady.
      assert.equal(
        experiment.validityGate([
          { perfect: 0.5, none: 0.4 },
          { perfect: 0.6, none: 0.5 },
          { perfect: 0.7, none: 0.6 },
        ])!.passes,
        false,
      );
      // Two pubs give no interval, so the gate cannot pass.
      assert.equal(
        experiment.validityGate([
          { perfect: 0.9, none: 0.1 },
          { perfect: 0.8, none: 0.1 },
        ])!.passes,
        false,
      );
      assert.equal(experiment.validityGate([]), null);
    },
  );

  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
