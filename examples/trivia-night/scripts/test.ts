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
  await check("platform evals: each venue's four night 2s", () => {
    const profiles = [
      { slug: "melbourne", label: "Melbourne (AU)", region: "au" },
      { slug: "leeds", label: "Leeds (UK)", region: "uk" },
    ];
    const chains = evals.plan("r1", 3, profiles);
    // Three chains per venue, then one wrong-notes chain per venue.
    assert.equal(chains.length, 12);
    assert.equal(chains.flat().length, 21);
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
    // Other notes: each pub's placebo is a customer of its own whose memory
    // another pub's night 1 wrote first; no placebo shares an identity or waits
    // for the donor's own nights.
    const wrong = chains.slice(9);
    assert.deepEqual(
      wrong.map((chain) =>
        chain.map((step) => [step.night, step.task, step.identity, step.donor]),
      ),
      [
        [
          [
            "night1-donor",
            "night1-leeds",
            "anon:sim-r1-melbourne-wrong",
            "leeds",
          ],
          [
            "night2-wrong",
            "night2-melbourne",
            "anon:sim-r1-melbourne-wrong",
            "leeds",
          ],
        ],
        [
          [
            "night1-donor",
            "night1-melbourne",
            "anon:sim-r1-leeds-wrong",
            "melbourne-2",
          ],
          [
            "night2-wrong",
            "night2-leeds",
            "anon:sim-r1-leeds-wrong",
            "melbourne-2",
          ],
        ],
        [
          [
            "night1-donor",
            "night1-leeds",
            "anon:sim-r1-melbourne-2-wrong",
            "leeds",
          ],
          [
            "night2-wrong",
            "night2-melbourne",
            "anon:sim-r1-melbourne-2-wrong",
            "leeds",
          ],
        ],
      ],
    );
    assert.equal(wrong[0][1].variant, "wrong");
    const identities = wrong.map((chain) => chain[0].identity);
    assert.equal(new Set(identities).size, identities.length);
    for (const chain of wrong) {
      assert.notEqual(chain[0].donor, chain[0].venue);
      assert.ok(chain.every((step) => !step.after?.length));
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
        /reward =\s+fetches\.length >= 6 && \(measures\.in_band \?\? 0\) >= 0\.5/,
      );
      assert.match(
        read("night2-melbourne/tests/check.mjs"),
        /\.length \/ Math\.max\(6, fetches\.length\)/,
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

  const runner = await import("../lib/platform-runner");
  const { hostEvents, loadedMemory } = await import("../lib/trial-steps");
  const { tarGz } = await import("../lib/tar");
  const TARGET = {
    runtime: "01a20a7c-077e-7066-8429-59576969a693",
    commit: "393c952f976e52419f415a60b4f6c6944776eb2b",
    slug: "trivia-host",
    repository: "9e02cb78-24f4-57f0-8725-568e0dfff815",
    recipe_path: "",
  };
  const COMPOSE = [
    "services:",
    "  main:",
    "    depends_on:",
    "      fakes:",
    "        condition: service_healthy",
    "    volumes:",
    "      - fakes-verifier:/opt/fakes-verifier:ro",
    "  fakes:",
    "    build:",
    "      context: ../../../../fakes",
    "    environment:",
    '      EVAL_SIMULATE_NIGHT: "1"',
    "    volumes:",
    "      - fakes-verifier:/verifier",
    "volumes:",
    "  fakes-verifier: {}",
    "",
  ].join("\n");
  const KEY = "intro_sk_secret_value";

  await check("platform evals: a click names its run", async () => {
    const run = await runner.runIdFor("m-1", "click-1");
    assert.match(run, /^r\d+$/);
    assert.equal(await runner.runIdFor("m-1", "click-1"), run);
    assert.notEqual(await runner.runIdFor("m-1", "click-2"), run);
    assert.notEqual(await runner.runIdFor("m-2", "click-1"), run);
    assert.match(runner.ADD_RUNTIME, /runtimes create --manifest/);
  });

  await check(
    "platform evals: a local script acts on the stack the CLI signed in to",
    async () => {
      const { cliSession } = await import("../lib/cli-session");
      const dir = mkdtempSync(path.join(tmpdir(), "trivia-cli-"));
      const file = path.join(dir, "credentials.json");
      writeFileSync(
        file,
        JSON.stringify({
          cp_url: "http://localhost:8000",
          dp_url: "http://localhost:8002",
          access_token: "a-token",
          project_id: "p-1",
          member_id: "m-1",
        }),
      );
      const signedIn = cliSession({ INTROSPECTION_CREDENTIALS: file });
      assert.equal(signedIn.api, "http://localhost:8000");
      assert.deepEqual([signedIn.project, signedIn.member], ["p-1", "m-1"]);
      assert.equal(
        cliSession({
          INTROSPECTION_CREDENTIALS: file,
          INTROSPECTION_API_BASE_URL: "http://localhost:9000",
        }).api,
        "http://localhost:9000",
      );
      writeFileSync(file, JSON.stringify({ cp_url: "http://localhost:8000" }));
      assert.throws(
        () => cliSession({ INTROSPECTION_CREDENTIALS: file }),
        /introspection login/,
      );
      rmSync(dir, { recursive: true });
    },
  );

  await check(
    "platform evals: a tests archive unpacks with plain tar and has no . entry",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "trivia-tar-"));
      const archive = path.join(dir, "tests.tar.gz");
      const files = [
        { path: "test.sh", content: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
        { path: "nested/expected.json", content: Buffer.from("{}") },
      ];
      writeFileSync(archive, await tarGz(files));
      assert.deepEqual(Buffer.from(await tarGz(files)), readFileSync(archive));
      assert.deepEqual(
        execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
          .trim()
          .split("\n"),
        ["nested/expected.json", "test.sh"],
      );
      execFileSync("tar", ["-xzf", archive, "-C", dir]);
      assert.equal(
        readFileSync(path.join(dir, "test.sh"), "utf8"),
        "#!/bin/sh\n",
      );
      assert.ok(statSync(path.join(dir, "test.sh")).mode & 0o100);
      rmSync(dir, { recursive: true });
    },
  );

  await check(
    "platform evals: a trial is a kind=eval task named by its metadata.task_path",
    async () => {
      const { parse } = await import("yaml");
      const document = parse(COMPOSE) as Record<string, unknown>;
      const definition: import("../lib/platform-runner").TaskDefinition = {
        task: "night1-sydney",
        compose: document,
        contexts: runner.buildContexts(
          document,
          "evals/harbor/night1-sydney/environment",
        ),
      };
      assert.deepEqual(definition.contexts, { fakes: "fakes" });
      const images = { fakes: "registry/fakes:x@sha256:1" };
      const compose = runner.trialCompose(definition.compose, images);
      assert.deepEqual(compose, {
        services: {
          main: {
            depends_on: { fakes: { condition: "service_healthy" } },
            volumes: [
              "fakes-verifier:/opt/fakes-verifier:ro",
              "harbor-logs:/logs",
              "harbor-tests:/tests",
            ],
          },
          fakes: {
            environment: { EVAL_SIMULATE_NIGHT: "1" },
            volumes: ["fakes-verifier:/verifier"],
            image: "registry/fakes:x@sha256:1",
          },
        },
        volumes: {
          "fakes-verifier": {},
          "harbor-logs": null,
          "harbor-tests": null,
        },
      });
      assert.throws(
        () =>
          runner.trialCompose({ services: { main: { image: "mine" } } }, {}),
        /Runtime image fills main/,
      );
      const record = {
        run: "r1",
        venues: 1,
        teams: 5 as const,
        pubs: "development" as const,
        started_by: "m-1",
        started_at: "2026-11-24T00:00:00Z",
        target: TARGET,
      };
      const step = evals.runSteps(record)[0];
      const body = await runner.trialBody(record, step, compose);
      assert.deepEqual(
        { ...body, compose: undefined, metadata: undefined },
        {
          kind: "eval",
          runtime_id: TARGET.runtime,
          recipe_git_commit_sha: TARGET.commit,
          commands: true,
          tags: ["simulation:r1", "simulation:trivia-night"],
          compose: undefined,
          metadata: undefined,
        },
      );
      assert.deepEqual(body.metadata, {
        // The platform reads the prompt and the verifier from here.
        task_path: "evals/harbor/night1-sydney",
        admission_key: await runner.admissionKey(step),
        identity: {
          anonymous_id: "sim-r1-sydney",
          tags: ["simulation:r1", "simulation:trivia-night"],
        },
        trivia_night: { step: "sydney/night1-memory", record },
      });
      assert.ok(!JSON.stringify(body).includes(KEY));
      // One key per step of a run, the same from any instance.
      const keys = await Promise.all(
        evals.runSteps(record).map(runner.admissionKey),
      );
      assert.equal(new Set(keys).size, keys.length);
      assert.equal(await runner.admissionKey(step), keys[0]);
      assert.match(
        keys[0],
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.notEqual(
        await runner.admissionKey({ ...step, run: "r2" }),
        keys[0],
      );
    },
  );

  await check(
    "platform evals: the verifier keeps the host's steps from the sandbox's GenAI spans",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "trivia-steps-"));
      // A real night 1's spans file, as the runtime wrote it in the sandbox, trimmed to the
      // fields the verifier reads (scripts/fixtures/night1-genai-spans.json).
      const file = path.join(
        import.meta.dirname,
        "fixtures/night1-genai-spans.json",
      );
      const spans = JSON.parse(readFileSync(file, "utf8")) as {
        data: { name: string }[];
      };
      const tools = spans.data.filter((span) =>
        span.name.startsWith("execute_tool "),
      );
      const checkFile = path.join(dir, "check.mjs");
      writeFileSync(
        checkFile,
        [
          'import { existsSync, readFileSync } from "node:fs";',
          "const written = {};",
          "const writeFileSync = (to, text) => { written[to] = JSON.parse(text); };",
          "const console = { log: (text) => { written.report = JSON.parse(text); } };",
          'const expected = { region: "au", liked: ["film"] };',
          venuesGen.HOST_STEPS,
          // A night with 3 lead changes over its 6 rounds.
          "const scores = { reward: 1, notes_written: 1, in_band: 0.5, lead_changes: 0.6, lead_changes_count: 3, rounds_played: 6 };",
          "writeResult(scores, { ...scores, rounds: [] });",
          "export { clip, written };",
        ].join("\n"),
      );
      process.env.PI_RECIPE_GENAI_SPANS_FILE = file;
      const { clip, written } = (await import(checkFile)) as {
        clip: (text: string, max: number) => string;
        written: Record<string, Record<string, unknown>>;
      };
      delete process.env.PI_RECIPE_GENAI_SPANS_FILE;
      // Harbor reads every reward.json value as a reward in [0, 1]; the raw counts, the
      // steps and the tastes go in the printed report, which the platform keeps as the log.
      const rewards = written["/logs/verifier/reward.json"];
      assert.deepEqual(rewards, {
        reward: 1,
        notes_written: 1,
        in_band: 0.5,
        lead_changes: 0.6,
      });
      for (const value of Object.values(rewards))
        assert.ok(typeof value === "number" && value >= 0 && value <= 1);
      const result = written.report;
      assert.equal(result.reward, 1);
      assert.equal(result.lead_changes_count, 3);
      assert.equal(result.rounds_played, 6);
      assert.deepEqual(result.tastes, { region: "au", liked: ["film"] });
      const steps = result.steps as {
        name: string;
        result: string;
        error: boolean;
      }[];
      // Every tool call, in order, each result cut short except a memory file's.
      assert.deepEqual(
        steps.map((step) => step.name),
        tools.map((span) => span.name.slice("execute_tool ".length)),
      );
      for (const step of steps)
        if (step.name !== "write" && step.name !== "read")
          assert.ok(step.result.length <= 240);
      assert.ok(steps.some((step) => step.result.endsWith("…")));
      assert.equal(steps[0].error, true);
      assert.ok((result.plan as string).length > 0);
      assert.ok((result.plan as string).length <= 2000);
      // Anything credential-shaped is redacted before it is kept.
      assert.equal(
        clip("token intro_sk_abcdefghijklmnopqrstu end", 4000),
        "token [redacted] end",
      );
      assert.equal(clip("x".repeat(300), 240).length, 240);
      const events = hostEvents(result.steps, result.plan);
      assert.equal(
        events[0].summary,
        "Loading memory · none yet — first visit",
      );
      const types = new Set(events.map((e) => e.type));
      for (const type of [
        "bank.served",
        "bank.marked",
        "memory.written",
        "host.planned",
      ])
        assert.ok(types.has(type as never), type);
      // The page reads them from the report the platform keeps as the log.
      const out = evals.verifierOutput(
        `starting\n${JSON.stringify(result)}\n`,
        JSON.stringify(written["/logs/verifier/reward.json"]),
      );
      assert.equal(out.steps.length, events.length);
      assert.equal(out.checks.notes_written, 1);
      assert.deepEqual(out.tastes, { region: "au", liked: ["film"] });
      assert.deepEqual(loadedMemory("# Sydney").data, {
        path: "memories/MEMORY.md",
        file: "# Sydney",
      });
      assert.deepEqual(
        hostEvents([{ name: "bash", arguments: { command: "ls" } }], null).map(
          (e) => e.type,
        ),
        ["host.tool"],
      );
      rmSync(dir, { recursive: true });
    },
  );

  await check("platform evals: the verifier's log and result are read", () => {
    const log = `starting\n${JSON.stringify({
      reward: 1,
      night_started: 1,
      good_rounds: 0.5,
      notes: "  # Notes\n",
      fetches: [{ round: 1, correct_rate: 0.6 }],
      rounds: [{ round: 1, genre: "film", questions: [] }],
    })}\n`;
    const out = evals.verifierOutput(log, '{"reward": 0}', 1);
    assert.equal(out.reward, 1);
    assert.deepEqual(out.checks, { night_started: 1, good_rounds: 0.5 });
    assert.equal(out.notes, "# Notes");
    assert.equal(out.fetches.length, 1);
    assert.equal(out.rounds[0].genre, "film");
    // No JSON in the log: the result file stands in.
    assert.deepEqual(
      evals.verifierOutput("Error: boom", '{"reward": 0, "notes_written": 0}'),
      {
        reward: 0,
        checks: { notes_written: 0 },
        notes: null,
        fetches: [],
        rounds: [],
        steps: [],
        steps_error: null,
        tastes: null,
      },
    );
    assert.deepEqual(evals.verifierOutput(null, null).checks, {});
  });

  await check(
    "platform evals: a cancelled run starts no dependent night, and a skip names how the night before ended",
    () => {
      const record = {
        run: "r1",
        venues: 1,
        teams: 5 as const,
        pubs: "development" as const,
        started_by: "m-1",
        started_at: "2026-11-24T00:00:00Z",
        target: TARGET,
      };
      const steps = evals.runSteps(record);
      const night1 = steps.find((s) => s.night === "night1-memory")!;
      const hosted = steps.find((s) => s.after?.[0] === evals.stepKey(night1))!;
      const done = new Map([
        [
          evals.stepKey(night1),
          { done: true, failed: false, error: null, status: "completed" },
        ],
      ]);
      // Night 1 scored: night 2 starts, unless the run was cancelled.
      assert.deepEqual(evals.untriedStep(hosted, done, false), {});
      assert.deepEqual(evals.untriedStep(hosted, done, true), {
        skip: "skipped: the run was cancelled",
      });
      assert.deepEqual(evals.untriedStep(hosted, new Map(), false), {
        wait: true,
      });
      const ended = (status?: string) =>
        new Map([
          [
            evals.stepKey(night1),
            { done: true, failed: true, error: "x", status },
          ],
        ]);
      assert.equal(
        evals.untriedStep(hosted, ended("cancelled"), false).skip,
        "skipped: night1-memory cancelled",
      );
      assert.equal(
        evals.untriedStep(hosted, ended("failed"), false).skip,
        "skipped: night1-memory failed",
      );
      assert.equal(
        evals.untriedStep(hosted, ended(undefined), false).skip,
        "skipped: night1-memory skipped",
      );
      assert.equal(
        evals.runCancelled({ [evals.RUN_CANCELLED_KEY]: true }),
        true,
      );
      assert.equal(evals.runCancelled({}), false);
    },
  );

  await check("platform evals: a trial's state", () => {
    const state = (task: Parameters<typeof evals.trialState>[0]) => ({
      ...evals.trialState(task),
    });
    const verified = (fields: Record<string, unknown> = {}) => ({
      settled_run_id: "run-1",
      verification: {
        run_id: "run-1",
        reward: 1,
        exit_code: 0,
        completed_at: "2026-11-24T00:01:30Z",
        ...fields,
      },
    });
    assert.deepEqual(state({ status: "running" }), {
      done: false,
      failed: false,
      error: null,
    });
    // Verified while finishing, but not done until the task ends and its notes are kept.
    assert.deepEqual(state({ status: "finishing", metadata: verified() }), {
      done: false,
      failed: false,
      error: null,
    });
    assert.deepEqual(state({ status: "completed", metadata: verified() }), {
      done: true,
      failed: false,
      error: null,
    });
    assert.equal(
      evals.trialVerification(verified({ log_file_id: "f-1" }))?.log_file_id,
      "f-1",
    );
    assert.equal(
      state({ status: "completed", metadata: verified({ exit_code: 2 }) })
        .error,
      "the verifier exited 2",
    );
    assert.equal(
      state({ status: "completed", metadata: verified({ error: "no result" }) })
        .error,
      "no result",
    );
    // Completed without a verification: its verifier never ran, so it failed.
    assert.deepEqual(state({ status: "completed", metadata: {} }), {
      done: true,
      failed: true,
      error: "the trial ended without its verifier running",
    });
    assert.equal(evals.trialVerification({ verification: "junk" }), null);
    // Ended before it was scored: failed, with the task's own reason.
    assert.deepEqual(
      state({ status: "failed", metadata: { error: "sandbox did not start" } }),
      {
        done: true,
        failed: true,
        error: "sandbox did not start",
      },
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

  const display = await import("../lib/display");

  await check(
    "display: a notes line drops its markdown, a target is short",
    () => {
      assert.equal(
        display.plainLine("- **Country:** UK. Use region `uk` only."),
        "Country: UK. Use region uk only.",
      );
      assert.equal(
        display.targetLabel("trivia-host", "e328209abcdef0123"),
        "trivia-host @ e328209",
      );
      assert.equal(
        display.targetLabel(
          "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
          "e328209ab",
        ),
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
    },
  );

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

  const login = await import("../lib/browser-session");
  /** sessionStorage as the page uses it. */
  const memoryStorage = () => {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    };
  };

  await check(
    "sign-in: the hosted login names the project (or lets the member pick one) and asks for the run's scopes, with an S256 challenge",
    async () => {
      const storage = memoryStorage();
      const url = new URL(
        await login.loginUrl(storage, "http://localhost:3500/callback", {
          ...login.CONFIG,
          cpUrl: "http://localhost:8000/",
          clientId: "intro_app_x",
        }),
      );
      assert.equal(
        url.origin + url.pathname,
        "http://localhost:8000/v1/oauth/authorize",
      );
      assert.deepEqual(
        url.searchParams.get("scope")!.split(" "),
        login.LOGIN_SCOPES,
      );
      assert.equal(url.searchParams.get("project"), login.CONFIG.project);
      assert.equal(url.searchParams.get("prompt"), null);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const picking = new URL(
        await login.loginUrl(
          memoryStorage(),
          "http://localhost:3500/callback",
          {
            ...login.CONFIG,
            clientId: "intro_app_x",
            project: "",
          },
        ),
      );
      assert.equal(picking.searchParams.get("project"), null);
      assert.equal(picking.searchParams.get("prompt"), "consent");
      const flow = JSON.parse(storage.items.get("trivia-night:login")!);
      assert.equal(url.searchParams.get("state"), flow.state);
      assert.ok(!url.href.includes(flow.verifier));
    },
  );

  await check(
    "sign-in: the token is kept until it expires, then the page signs in again",
    () => {
      const storage = memoryStorage();
      const session = {
        access_token: "a-token",
        member_id: "m-1",
        project_id: "p-1",
        scope: ["tasks:read", "files:read"],
        expires_at: 1_000_000,
      };
      storage.setItem("trivia-night:session", JSON.stringify(session));
      assert.deepEqual(login.storedSession(storage, 999_999), session);
      assert.equal(login.storedSession(storage, 1_000_000), null);
      assert.equal(storage.items.has("trivia-night:session"), false);
      assert.equal(login.storedSession(storage), null);
      // Only an owner or admin holds what a run needs beyond reading.
      assert.deepEqual(login.missingScopes(session, login.RUN_SCOPES), [
        "tasks:write",
        "tasks:eval",
        "tasks:exec",
        "files:write",
      ]);
      assert.equal(
        login.configuredTarget({ ...login.CONFIG, runtime: "" }),
        null,
      );
      assert.deepEqual(
        login.configuredTarget({
          ...login.CONFIG,
          runtime: "rt",
          repository: "repo",
          commit: "c1",
          recipePath: "",
        }),
        { runtime: "rt", commit: "c1", repository: "repo", recipe_path: "" },
      );
    },
  );

  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
