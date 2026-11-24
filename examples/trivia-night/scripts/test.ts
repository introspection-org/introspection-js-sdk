/** Checks of the bank, its MCP server, the scoring and the platform evals: `pnpm test`. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      "evals/harbor/night2-hosted",
      "--identity",
      "anon:sim-r1-venue-a",
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
      "/work/recipe-operator/eval-runs/r1/venue-a-night2-hosted",
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

  const trial = await import("../lib/trial-stream");
  const TASK = "01a20baa-4fd6-75ff-972d-958abcaadb64";
  const notes = "# Venue notes\n\n- Country: UK\n- Difficulty: 3\n";
  const kinds = (events: { type: string }[]) => events.map((e) => e.type);

  await check(
    "trial stream: the task id is read from eval run's output",
    () => {
      assert.equal(
        trial.parseTaskId(
          `Running night1-memory\ntask ${TASK} is queued on the org's \`eval\` lane\n`,
        ),
        TASK,
      );
      assert.equal(trial.parseTaskId("Running night1-memory\n"), null);
    },
  );

  await check("trial stream: AG-UI lines become the page's events", () => {
    let seq = 0;
    const line = (event: Record<string, unknown>) =>
      JSON.stringify({
        task_id: TASK,
        run_id: "run-1",
        event_id: String((seq += 1)),
        event,
      });
    const call = (id: string, name: string, args: object) => [
      line({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name }),
      line({
        type: "TOOL_CALL_ARGS",
        toolCallId: id,
        delta: JSON.stringify(args).slice(0, 5),
      }),
      line({
        type: "TOOL_CALL_ARGS",
        toolCallId: id,
        delta: JSON.stringify(args).slice(5),
      }),
      line({ type: "TOOL_CALL_END", toolCallId: id }),
    ];
    const result = (id: string, text: string) =>
      line({
        type: "TOOL_CALL_RESULT",
        messageId: `run-1:result:${id}`,
        toolCallId: id,
        role: "tool",
        content: JSON.stringify({ content: [{ type: "text", text }] }),
      });
    const lines = [
      line({ type: "RUN_STARTED", threadId: TASK, runId: "run-1" }),
      ...call("toolu_recipe_memory_read", "read", {
        path: "/workspace/memories/MEMORY.md",
      }),
      result("toolu_recipe_memory_read", notes),
      ...call("t1", "mcp_trivia-bank_start_night_33be65a290", {}),
      result("t1", '{"week":2}'),
      ...call("t2", "mcp_trivia-bank_next_questions_520f9420fe", {
        count: 8,
        difficulty: 3,
        genre: "history",
        region: "uk",
      }),
      ...call("t3", "mcp_trivia-bank_submit_round_0a1b2c3d4e", {
        answers: [{}, {}],
      }),
      ...call("t4", "bash", { command: "ls" }),
      ...call("t5", "write", {
        path: "/workspace/memories/MEMORY.md",
        content: notes,
      }),
      line({ type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" }),
      line({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "m1",
        delta: "Evening! ",
      }),
      line({
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "m1",
        delta: "Tonight is history at 3.",
      }),
      line({ type: "TEXT_MESSAGE_END", messageId: "m1" }),
      line({ type: "CUSTOM", name: "something.else", value: {} }),
      "not json",
      line({ type: "RUN_FINISHED", threadId: TASK, runId: "run-1" }),
    ];
    const mapper = new trial.StreamMapper();
    const events = lines.flatMap((text) => mapper.push(text));
    assert.deepEqual(kinds(events), [
      "memory.read",
      "bank.served",
      "bank.served",
      "bank.marked",
      "memory.written",
      "host.planned",
    ]);
    assert.equal(events[0].data.file, notes);
    assert.deepEqual(events[2].data, {
      tool: "next_questions",
      arguments: { count: 8, difficulty: 3, genre: "history", region: "uk" },
    });
    assert.match(
      events[2].summary,
      /genre history, difficulty 3, region uk, 8 questions/,
    );
    assert.equal(events[4].data.file, notes);
    assert.equal(events[5].data.file, "Evening! Tonight is history at 3.");
    assert.ok(mapper.ended);
    assert.equal(mapper.runId, "run-1");
    assert.equal(mapper.cursor, seq);

    // A reattach behind the replay buffer gets one snapshot of the run.
    const again = new trial.StreamMapper();
    const snapshot = again.push(
      JSON.stringify({
        task_id: TASK,
        run_id: "run-1",
        event_id: "40",
        event: {
          type: "MESSAGES_SNAPSHOT",
          messages: [
            {
              id: "a1",
              role: "assistant",
              toolCalls: [
                {
                  id: "t2",
                  type: "function",
                  function: {
                    name: "mcp_trivia-bank_next_questions_520f9420fe",
                    arguments: '{"count":2}',
                  },
                },
                {
                  id: "t6",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: '{"path":"memories/MEMORY.md"}',
                  },
                },
              ],
            },
            { id: "r1", role: "tool", toolCallId: "t6", content: notes },
          ],
        },
      }),
    );
    assert.deepEqual(kinds(snapshot), ["bank.served", "memory.read"]);
    assert.equal(snapshot[1].data.file, notes);
    assert.equal(again.cursor, 40);
  });

  await check(
    "trial stream: a trajectory fills what the stream missed, once",
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
          message: "Tonight: history at 3. " + "x".repeat(400),
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
      assert.equal((events[3].data.file as string).length, 300);

      // The keys match the stream's, so the runner shows each event once.
      const streamed = new trial.StreamMapper().push(
        JSON.stringify({
          event_id: "1",
          event: {
            type: "TOOL_CALL_START",
            toolCallId: "t1",
            toolCallName: "mcp_trivia-bank_next_questions_520f9420fe",
          },
        }),
      );
      assert.equal(streamed.length, 0);
      const ended = new trial.StreamMapper();
      for (const event of [
        {
          type: "TOOL_CALL_START",
          toolCallId: "t1",
          toolCallName: "mcp_trivia-bank_next_questions_520f9420fe",
        },
        { type: "TOOL_CALL_ARGS", toolCallId: "t1", delta: '{"count":8}' },
        { type: "TOOL_CALL_END", toolCallId: "t1" },
      ])
        streamed.push(...ended.push(JSON.stringify({ event })));
      const keys = new Set(streamed.map((event) => event.key));
      assert.deepEqual(
        events
          .filter((event) => !keys.has(event.key))
          .map((event) => event.type),
        ["memory.read", "memory.written", "host.planned"],
      );
      rmSync(base, { recursive: true });
    },
  );

  await check(
    "trial stream: the key goes only in the stream's environment",
    () => {
      const key = "intro_sk_secret_value";
      const credentials = {
        token: key,
        apiBaseUrl: "https://api.example.test",
      };
      const first = trial.streamSpec(
        TASK,
        "/work/recipe-operator",
        credentials,
        {
          runId: null,
          since: 0,
        },
      );
      assert.deepEqual(first.args, [
        "tasks",
        "stream",
        TASK,
        "--non-interactive",
      ]);
      const resumed = trial.streamSpec(
        TASK,
        "/work/recipe-operator",
        credentials,
        { runId: "run-1", since: 17 },
        { PATH: "/bin" },
      );
      assert.deepEqual(resumed.args, [
        "tasks",
        "stream",
        TASK,
        "--non-interactive",
        "--run",
        "run-1",
        "--since",
        "17",
      ]);
      for (const spec of [first, resumed]) {
        assert.equal(spec.command, "introspection");
        assert.equal(spec.options.shell, false);
        assert.ok(spec.args.every((arg) => !arg.includes(key)));
        assert.equal(spec.options.env.INTROSPECTION_TOKEN, key);
        assert.equal(
          spec.options.env.INTROSPECTION_API_BASE_URL,
          "https://api.example.test",
        );
      }
    },
  );

  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
