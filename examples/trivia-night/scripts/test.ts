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
  const { tarGz } = await import("../lib/tar");
  const TARGET = {
    runtime: "01a20a7c-077e-7066-8429-59576969a693",
    commit: "393c952f976e52419f415a60b4f6c6944776eb2b",
    slug: "trivia-host",
    repository: "9e02cb78-24f4-57f0-8725-568e0dfff815",
    recipe_path: "",
  };
  const FAKES_TREE = "ac4d3d2e716a728b3afa1763a9181ee8e1fd7d05";
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
  /** One Harbor task as the hosted repository holds it. */
  const taskFiles = (task: string) => ({
    [`evals/harbor/${task}/instruction.md`]: `Play ${task}.\n`,
    [`evals/harbor/${task}/task.toml`]:
      '[task]\nname = "trivia-host/x"\n\n[verifier]\ntimeout_sec = 120.0\n',
    [`evals/harbor/${task}/tests/test.sh`]:
      "#!/bin/sh\nnode /tests/check.mjs\n",
    [`evals/harbor/${task}/tests/check.mjs`]: "console.log('{}')\n",
    [`evals/harbor/${task}/tests/expected.json`]: JSON.stringify({
      region: "au",
      liked: ["film"],
    }),
    [`evals/harbor/${task}/environment/docker-compose.yaml`]: COMPOSE,
  });
  const REPO: Record<string, string> = {
    ...taskFiles("night1-sydney"),
    ...taskFiles("night2-sydney"),
    ...taskFiles("night0-sydney"),
    "fakes/Dockerfile": "FROM node:22-slim\n",
  };
  const KEY = "intro_sk_secret_value";

  /** An in-memory platform: tasks, files, images and the hosted repository, through the SDK's shapes. */
  function fakePlatform() {
    const tasks: Record<string, Record<string, unknown>>[] = [];
    const calls: string[] = [];
    const files = new Map<string, Uint8Array>();
    let next = 0;
    const id = () =>
      `0199a1b2-0000-7000-8000-${String(++next).padStart(12, "0")}`;
    const pages = <T>(records: T[]) =>
      Object.assign(Promise.resolve({ records, next: null }), {
        async *[Symbol.asyncIterator]() {
          yield* records;
        },
      });
    const entries = (dir: string) => {
      const prefix = dir ? `${dir}/` : "";
      const seen = new Map<string, { type: string; sha: string }>();
      for (const file of Object.keys(REPO)) {
        if (!file.startsWith(prefix)) continue;
        const [name, ...rest] = file.slice(prefix.length).split("/");
        seen.set(name, {
          type: rest.length ? "dir" : "file",
          sha: `${prefix}${name}` === "fakes" ? FAKES_TREE : "f".repeat(40),
        });
      }
      return [...seen].map(([name, { type, sha }]) => ({
        name,
        path: `${prefix}${name}`,
        type,
        size: 1,
        sha,
      }));
    };
    const contents = Object.assign(
      (_repo: string, params: { path?: string; ref?: string }) => {
        assert.equal(params.ref, TARGET.commit);
        return pages(entries(params.path ?? ""));
      },
      {
        get: async (_repo: string, file: string, params: { ref?: string }) => {
          assert.equal(params.ref, TARGET.commit);
          if (!(file in REPO))
            throw Object.assign(new Error("not found"), { status: 404 });
          return {
            type: "file",
            content: REPO[file],
            encoding: "utf-8",
            truncated: false,
          };
        },
      },
    );
    const find = (taskId: string) => {
      const task = tasks.find((t) => t.task.id === taskId);
      assert.ok(task, `no task ${taskId}`);
      return task.task;
    };
    const client = {
      runtimes: {
        resolve: async () => ({
          id: TARGET.runtime,
          slug: "trivia-host",
          git_commit_sha: TARGET.commit,
          recipe_id: "recipe-1",
          project_id: "p-1",
        }),
        get: async () => ({ id: TARGET.runtime, project_id: "p-1" }),
      },
      recipes: {
        get: async () => ({ repository_id: TARGET.repository, sub_path: "." }),
      },
      repositories: { contents },
      images: {
        list: async (params: { name: string; status: string }) => {
          return {
            records:
              params.name === `trivia-night/fakes/${FAKES_TREE.slice(0, 12)}`
                ? [{ image_ref: "registry/fakes:x", image_digest: "sha256:1" }]
                : [],
          };
        },
      },
      files: {
        upload: async (body: { file: Uint8Array; ttl_seconds?: number }) => {
          const fileId = id();
          files.set(fileId, body.file);
          assert.ok(body.ttl_seconds);
          return { id: fileId };
        },
        download: async (fileId: string) => files.get(fileId)!,
      },
      tasks: {
        create: async (body: Record<string, unknown>) => {
          const task = {
            id: id(),
            created_at: new Date(
              Date.UTC(2026, 10, 24, 0, 0, next),
            ).toISOString(),
            updated_at: "2026-11-24T00:00:00Z",
            status: "queued",
            is_archived: false,
            tags: body.tags,
            metadata: body.metadata,
            verification: { status: "pending" },
          };
          tasks.push({ task, body });
          calls.push(
            `create ${(body.metadata as Record<string, { step: string }>).trivia_night.step}`,
          );
          return { task, run: { id: "run", task_id: task.id } };
        },
        list: (params: { tag?: string }) =>
          pages(
            tasks
              .map((t) => t.task)
              .filter((t) => (t.tags as string[]).includes(params.tag!))
              .reverse(),
          ),
        get: async (taskId: string) => find(taskId),
        update: async (taskId: string, body: { status?: string }) => {
          calls.push(`complete ${taskId}`);
          assert.deepEqual(body, { status: "completed" });
          return find(taskId);
        },
        archive: async (taskId: string) => {
          calls.push(`archive ${taskId}`);
          find(taskId).is_archived = true;
        },
      },
    };
    const step = (key: string) => {
      const found = tasks.find(
        (t) =>
          (t.task.metadata as Record<string, { step: string }>).trivia_night
            .step === key,
      );
      assert.ok(found, `no task for ${key}`);
      return found;
    };
    /** Scores a step's trial as the platform would: a log, a result and its status. */
    const score = (key: string, printed: object, status = "completed") => {
      const logId = id();
      const resultId = id();
      files.set(logId, Buffer.from(`noise\n${JSON.stringify(printed)}\n`));
      files.set(resultId, Buffer.from(JSON.stringify({ reward: 1 })));
      Object.assign(step(key).task, {
        status,
        started_at: "2026-11-24T00:00:00Z",
        completed_at: "2026-11-24T00:01:30Z",
        verification: {
          status: "completed",
          reward: (printed as { reward?: number }).reward ?? null,
          exit_code: 0,
          log_file_id: logId,
          result_file_id: resultId,
          completed_at: "2026-11-24T00:01:30Z",
        },
      });
    };
    return {
      client:
        client as unknown as import("../lib/platform-runner").PlatformClient,
      tasks,
      calls,
      files,
      step,
      score,
    };
  }

  await check(
    "platform evals: the agent key comes from the environment, else its file",
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), "trivia-key-"));
      const file = path.join(dir, "agent.key");
      writeFileSync(file, `${KEY}\n`);
      assert.deepEqual(runner.agentKey({ TRIVIA_AGENT_KEY: ` ${KEY} ` }), {
        token: KEY,
      });
      assert.deepEqual(runner.agentKey({ TRIVIA_EVAL_KEY_FILE: file }), {
        token: KEY,
      });
      assert.deepEqual(
        runner.agentKey({
          TRIVIA_AGENT_KEY: "from-env",
          TRIVIA_EVAL_KEY_FILE: file,
        }),
        { token: "from-env" },
      );
      assert.match(
        (
          runner.agentKey({ TRIVIA_EVAL_KEY_FILE: path.join(dir, "none") }) as {
            missing: string;
          }
        ).missing,
        /does not exist/,
      );
      assert.ok("missing" in runner.agentKey({}));
      assert.equal(
        runner.dpBaseUrl({
          INTROSPECTION_API_BASE_URL: "http://localhost:8000",
        }),
        "http://localhost:8000",
      );
      assert.equal(
        runner.dpBaseUrl({ INTROSPECTION_DP_URL: "http://localhost:8002" }),
        "http://localhost:8002",
      );
      rmSync(dir, { recursive: true });
    },
  );

  await check(
    "platform evals: a tests archive unpacks with plain tar and has no . entry",
    () => {
      const dir = mkdtempSync(path.join(tmpdir(), "trivia-tar-"));
      const archive = path.join(dir, "tests.tar.gz");
      const files = [
        { path: "test.sh", content: Buffer.from("#!/bin/sh\n"), mode: 0o755 },
        { path: "nested/expected.json", content: Buffer.from("{}") },
      ];
      writeFileSync(archive, tarGz(files));
      assert.deepEqual(Buffer.from(tarGz(files)), readFileSync(archive));
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
    "platform evals: a trial is a kind=eval task carrying its own verifier",
    async () => {
      const { client, tasks } = fakePlatform();
      const definition = await runner.readTaskDefinition(
        client,
        TARGET,
        "night1-sydney",
      );
      assert.equal(definition.instruction, "Play night1-sydney.");
      assert.equal(definition.verifierSeconds, 120);
      assert.deepEqual(definition.contexts, { fakes: "fakes" });
      assert.deepEqual(definition.tastes, { region: "au", liked: ["film"] });
      assert.deepEqual(
        definition.tests.map((f) => [f.path, f.mode]),
        [
          ["test.sh", 0o755],
          ["check.mjs", 0o644],
          ["expected.json", 0o644],
        ],
      );
      const images = await runner.sidecarImages(client, TARGET, definition);
      assert.deepEqual(images, { fakes: "registry/fakes:x@sha256:1" });
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
      const body = runner.trialBody(
        record,
        step,
        definition,
        compose,
        "file-1",
      );
      assert.deepEqual(
        { ...body, compose: undefined, metadata: undefined },
        {
          prompt: "Play night1-sydney.",
          kind: "eval",
          runtime_id: TARGET.runtime,
          recipe_git_commit_sha: TARGET.commit,
          commands: true,
          idle_timeout_seconds: 3600,
          tags: ["simulation:r1", "simulation:trivia-night"],
          compose: undefined,
          verifier: {
            tests_file_id: "file-1",
            command: ["sh", "/tests/test.sh"],
            reward_path: "/logs/verifier/reward.json",
            timeout_seconds: 120,
          },
          metadata: undefined,
        },
      );
      assert.deepEqual(body.metadata, {
        identity: {
          anonymous_id: "sim-r1-sydney",
          tags: ["simulation:r1", "simulation:trivia-night"],
        },
        trivia_night: { step: "sydney/night1-memory", record },
      });
      assert.ok(!JSON.stringify(body).includes(KEY));
      assert.equal(tasks.length, 0);
    },
  );

  await check(
    "platform evals: a context with no image says how to build it",
    async () => {
      const { client } = fakePlatform();
      const definition = await runner.readTaskDefinition(
        client,
        TARGET,
        "night1-sydney",
      );
      await assert.rejects(
        runner.sidecarImages(
          client,
          { ...TARGET },
          {
            ...definition,
            contexts: { fakes: "evals" },
          },
        ),
        /pnpm sidecar:image/,
      );
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
      },
    );
    assert.deepEqual(evals.verifierOutput(null, null).checks, {});
  });

  await check("platform evals: a trial's state and what ends it", () => {
    const state = (task: Parameters<typeof evals.trialState>[0]) => ({
      ...evals.trialState(task),
      end: evals.readyToComplete(task),
    });
    assert.deepEqual(
      state({ status: "running", verification: { status: "pending" } }),
      {
        done: false,
        failed: false,
        ended: false,
        error: null,
        end: false,
      },
    );
    // Settled: completing the task is what verifies it.
    assert.equal(
      state({ status: "idle", verification: { status: "pending" } }).end,
      true,
    );
    assert.equal(
      state({ status: "finishing", verification: { status: "running" } }).done,
      false,
    );
    // Scored while finishing: done, but its sandbox, and so its notes, not yet released.
    assert.deepEqual(
      state({
        status: "finishing",
        verification: { status: "completed", exit_code: 0 },
      }),
      { done: true, failed: false, ended: false, error: null, end: false },
    );
    assert.deepEqual(
      state({
        status: "completed",
        verification: { status: "completed", exit_code: 0 },
      }),
      { done: true, failed: false, ended: true, error: null, end: false },
    );
    assert.equal(
      state({
        status: "completed",
        verification: { status: "completed", exit_code: 2 },
      }).error,
      "the verifier exited 2",
    );
    assert.equal(
      state({
        status: "completed",
        verification: { status: "failed", error: "no result" },
      }).error,
      "no result",
    );
    // Ended before it was scored: failed, with the task's own reason.
    assert.deepEqual(
      state({
        status: "failed",
        metadata: { error: "sandbox did not start" },
        verification: { status: "pending" },
      }),
      {
        done: true,
        failed: true,
        ended: true,
        error: "sandbox did not start",
        end: false,
      },
    );
  });

  await check(
    "platform evals: a run moves on from its tasks alone, and each night 2 waits for its night 1",
    async () => {
      const platform = fakePlatform();
      const { client, calls, step, score } = platform;
      const started = await runner.startRun(
        client,
        1,
        "m-1",
        5,
        "development",
        new Date(Date.UTC(2026, 10, 24)),
      );
      assert.equal(started.run, `r${Date.UTC(2026, 10, 24)}`);
      assert.deepEqual(started.target, TARGET);
      assert.deepEqual(
        calls.filter((c) => c.startsWith("create")),
        [
          "create sydney/night1-memory",
          "create sydney/night2-fresh",
          "create sydney/night0-seed",
        ],
      );
      const run = started.run;
      let view = (await runner.advanceRun(client, run))!;
      assert.deepEqual(
        view.trials.map((t) => [t.key, t.status]),
        [
          ["sydney/night1-memory", "queued"],
          ["sydney/night2-hosted", "waiting"],
          ["sydney/night2-fresh", "queued"],
          ["sydney/night0-seed", "queued"],
          ["sydney/night2-perfect", "waiting"],
        ],
      );
      assert.equal(view.finished, null);
      await assert.rejects(runner.startRun(client, 1, "m-1"), /still going/);

      // Night 1 settles: the page completes it, which verifies it.
      Object.assign(step("sydney/night1-memory").task, { status: "idle" });
      calls.length = 0;
      await runner.advanceRun(client, run);
      assert.deepEqual(calls, [
        `complete ${step("sydney/night1-memory").task.id}`,
      ]);

      // Scored but still tearing down: its night 2 waits for the notes to be kept.
      score(
        "sydney/night1-memory",
        { reward: 1, notes: "# Sydney\n- likes film" },
        "finishing",
      );
      calls.length = 0;
      await runner.advanceRun(client, run);
      assert.ok(!calls.some((c) => c.startsWith("create")));
      Object.assign(step("sydney/night1-memory").task, { status: "completed" });
      // Night 0 fails: the true-notes night 2 is skipped, never run.
      Object.assign(step("sydney/night0-seed").task, {
        status: "failed",
        metadata: {
          ...(step("sydney/night0-seed").task.metadata as object),
          error: "no sandbox",
        },
      });
      calls.length = 0;
      view = (await runner.advanceRun(client, run))!;
      assert.deepEqual(calls, ["create sydney/night2-hosted"]);
      const perfect = view.trials.find(
        (t) => t.key === "sydney/night2-perfect",
      )!;
      assert.equal(perfect.status, "skipped");
      assert.equal(perfect.finished?.error, "skipped: night0-seed failed");
      // The same identity runs night 2, so it loads night 1's notes.
      const hosted = step("sydney/night2-hosted");
      assert.deepEqual(
        (hosted.body.metadata as { identity: unknown }).identity,
        (step("sydney/night1-memory").body.metadata as { identity: unknown })
          .identity,
      );

      // Two pages created the same night 2: the later task is archived, the first kept.
      await client.tasks.create({ ...hosted.body });
      calls.length = 0;
      await runner.advanceRun(client, run);
      assert.deepEqual(calls, [`archive ${platform.tasks.at(-1)!.task.id}`]);

      score("sydney/night2-hosted", {
        reward: 1,
        good_rounds: 0.5,
        fetches: [{ round: 1, genre: "film", correct_rate: 0.6 }],
      });
      score("sydney/night2-fresh", { reward: 1, good_rounds: 0.25 });
      view = (await runner.advanceRun(client, run))!;
      assert.deepEqual(view.finished, {
        run,
        seconds: 90,
        trials: 5,
        started_by: "m-1",
      });
      assert.equal(await runner.latestRun(client), run);

      const result = (await runner.trialResult(
        client,
        hosted.task.id as string,
      ))!;
      assert.equal(result.night, "night2-hosted");
      assert.equal(result.reward, 1);
      assert.equal(result.checks.good_rounds, 0.5);
      assert.equal(result.seconds, 90);
      assert.equal(result.error, null);
      assert.equal(result.round?.correct_rate, 0.6);
      assert.ok(result.measures && Object.keys(result.measures).length > 0);
      const seed = (await runner.trialResult(
        client,
        step("sydney/night0-seed").task.id as string,
      ))!;
      assert.equal(seed.error, "no sandbox");
      assert.deepEqual(seed.measures, {});
    },
  );

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

  await check(
    "platform evals: the route refuses without a sign-in",
    async () => {
      const post = (cookie?: string) =>
        startEvals(
          new Request("http://localhost:3500/api/evals", {
            method: "POST",
            body: "{}",
            headers: cookie ? { cookie } : {},
          }),
        );
      assert.equal((await post()).status, 401);
      assert.equal((await post("trivia_session=forged")).status, 401);
    },
  );

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

  const results = await import("../lib/results");
  await check("trial results: kept on disk past the bounded feed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "trivia-results-"));
    const file = results.resultsFile(dir, "r1");
    assert.deepEqual(results.readResults(file), []);
    for (let i = 0; i < 2500; i++)
      results.appendResult(file, {
        type: "eval.finished",
        data: { run: "r1", venue: `pub-${i}`, night: "night2-fresh" },
      });
    results.appendResult(file, {
      type: "eval.run_finished",
      data: { run: "r1", trials: 2500 },
    });
    const lines = results.readResults(file);
    assert.equal(lines.length, 2501);
    assert.equal(lines[0].data.venue, "pub-0");
    assert.equal(lines.at(-1)?.type, "eval.run_finished");
  });
  await check("trial results: an errored trial is never analysed", () => {
    assert.equal(results.scored({ error: null }), true);
    assert.equal(results.scored({}), true);
    assert.equal(results.scored({ error: "sandbox failed" }), false);
    assert.equal(results.scored(null), false);
    assert.equal(results.scored(undefined), false);
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

  const login = await import("../lib/session");
  const PROJECT = "01a1f15d-4fb5-700d-841b-6fb6ff2a783d";
  const SECRET = "a-session-secret-of-at-least-32-characters";
  process.env.TRIVIA_SESSION_SECRET = SECRET;
  const sealing = login.sessionKey() as { key: Buffer };
  const jwt = (claims: Record<string, unknown>) =>
    ["{}", JSON.stringify(claims), "sig"]
      .map((part) => Buffer.from(part).toString("base64url"))
      .join(".");
  const exchangeFor =
    (claims: Record<string, unknown>) =>
    async (params: { codeVerifier: string }) => {
      assert.ok(params.codeVerifier.length >= 43);
      return {
        access_token: jwt(claims),
        token_type: "Bearer",
        expires_in: 60,
        scope: "tasks:read",
        dp_url: null,
      };
    };
  const callbackFor = (cookie: string) => ({
    code: "the-code",
    state: (JSON.parse(cookie) as { state: string }).state,
    cookie,
    redirectUri: "http://localhost:3510/callback",
    clientId: "intro_app_x",
    cpUrl: "http://localhost:8000",
    project: async () => PROJECT,
    key: sealing.key,
  });

  await check(
    "sign-in: the hosted login asks for one project with an S256 challenge",
    () => {
      const { url, cookie } = login.loginRequest(
        "intro_app_x",
        PROJECT,
        "http://localhost:3510/callback",
        "http://localhost:8000/",
      );
      const parsed = new URL(url);
      assert.equal(
        parsed.origin + parsed.pathname,
        "http://localhost:8000/v1/oauth/authorize",
      );
      assert.equal(parsed.searchParams.get("project"), PROJECT);
      assert.equal(parsed.searchParams.get("code_challenge_method"), "S256");
      const { verifier, state } = JSON.parse(cookie);
      assert.equal(parsed.searchParams.get("state"), state);
      assert.ok(!url.includes(verifier));
    },
  );

  await check(
    "sign-in: a member of the key's project gets a sealed session until the token expires",
    async () => {
      const { cookie } = login.loginRequest(
        "intro_app_x",
        PROJECT,
        "http://localhost:3510/callback",
        "http://localhost:8000",
      );
      const claims = { member_id: "m-1", org_id: "o-1", project_id: PROJECT };
      const now = Date.now();
      const opened = await login.completeLogin(
        callbackFor(cookie),
        exchangeFor(claims) as never,
        now,
      );
      const { session } = opened;
      assert.deepEqual(session, { ...claims, expires_at: now + 60_000 });
      // Sealed, not signed: the cookie names neither the member nor the project.
      assert.ok(!opened.cookie.includes("m-1"));
      assert.ok(
        !Buffer.from(opened.cookie, "base64url").toString().includes(PROJECT),
      );
      const request = new Request("http://localhost:3500/api/events", {
        headers: { cookie: `other=1; trivia_session=${opened.cookie}` },
      });
      assert.deepEqual(
        await login.requireSession(request, async () => PROJECT),
        { session },
      );
      const refusal = async (project: () => Promise<string>) =>
        ((await login.requireSession(request, project)) as { status: number })
          .status;
      assert.equal(await refusal(async () => "another-project"), 403);
      // Without a key the page cannot tell which project it runs in.
      const saved = {
        file: process.env.TRIVIA_EVAL_KEY_FILE,
        inline: process.env.TRIVIA_AGENT_KEY,
      };
      delete process.env.TRIVIA_EVAL_KEY_FILE;
      delete process.env.TRIVIA_AGENT_KEY;
      const response = await startEvals(
        new Request("http://localhost:3500/api/evals", {
          method: "POST",
          body: "{}",
          headers: { cookie: `trivia_session=${opened.cookie}` },
        }),
      );
      assert.equal(response.status, 503);
      assert.match((await response.json()).error, /TRIVIA_AGENT_KEY/);
      if (saved.file) process.env.TRIVIA_EVAL_KEY_FILE = saved.file;
      if (saved.inline) process.env.TRIVIA_AGENT_KEY = saved.inline;
      assert.equal(login.sessionFor(opened.cookie, now + 60_000), null);
      assert.deepEqual(login.sessionFor(opened.cookie, now), session);
      // Under another secret, tampered with, or with no secret at all, it opens nothing.
      assert.equal(
        login.sessionFor(opened.cookie, now, {
          TRIVIA_SESSION_SECRET: `${SECRET}-rotated`,
        }),
        null,
      );
      const bytes = Buffer.from(opened.cookie, "base64url");
      bytes[bytes.length - 20] ^= 1;
      assert.equal(login.sessionFor(bytes.toString("base64url"), now), null);
      assert.equal(login.sessionFor(opened.cookie, now, {}), null);
      assert.match(
        (
          login.sessionKey({ TRIVIA_SESSION_SECRET: "short" }) as {
            missing: string;
          }
        ).missing,
        /at least 32/,
      );
    },
  );

  await check(
    "sign-in: a wrong state, another project or no member opens no session",
    async () => {
      const { cookie } = login.loginRequest(
        "intro_app_x",
        PROJECT,
        "http://localhost:3510/callback",
        "http://localhost:8000",
      );
      const member = { member_id: "m-1", org_id: "o-1", project_id: PROJECT };
      const refused = async (
        callback: Parameters<typeof login.completeLogin>[0],
        claims: Record<string, unknown>,
      ) =>
        login.completeLogin(callback, exchangeFor(claims) as never).then(
          () => null,
          (error: InstanceType<typeof login.LoginRefused>) => error.status,
        );
      assert.equal(
        await refused({ ...callbackFor(cookie), state: "forged" }, member),
        401,
      );
      assert.equal(
        await refused({ ...callbackFor(cookie), cookie: undefined }, member),
        401,
      );
      assert.equal(
        await refused(callbackFor(cookie), { ...member, project_id: "other" }),
        403,
      );
      assert.equal(
        await refused(callbackFor(cookie), {
          org_id: "o-1",
          project_id: PROJECT,
        }),
        401,
      );
      const anonymous = new Request("http://localhost:3500/api/events");
      assert.equal(
        (
          (await login.requireSession(anonymous, async () => PROJECT)) as {
            status: number;
          }
        ).status,
        401,
      );
    },
  );

  console.log(`\n${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
