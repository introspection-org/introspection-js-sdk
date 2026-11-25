// Generates mcp/trivia-bank/questions.jsonll, the trivia bank's real questions: 40 for each of the
// 120 genre x region x difficulty cells (supply.ts serves them first; the rest of a cell stays placeholders).
// Each cell is half multiple choice (`format: "choice"`, four options, shuffled here by a stable hash)
// and half short answer (`format: "short"`), each tagged with the decade it is about.
//
// It runs Pi headless on your own Pi sign-in, never an API key: run `pi auth login anthropic` first.
// The script refuses to start unless Pi reports an OAuth sign-in, and unsets ANTHROPIC_API_KEY,
// OPENAI_API_KEY and ANTHROPIC_AUTH_TOKEN for every call. It asks Claude Opus, falling back to
// Claude Sonnet when the sign-in cannot reach Opus.
//
//   npm run generate:questions [-- --cache <dir>]
//
// One Pi turn per cell, about 120 in all, plus a retry for any reply that fails validation.
//
//   npm run generate:questions -- --validate [--per-cell 60] [--rounds 8] [--cache <dir>]
//
// then checks the bank and tops each cell up to --per-cell questions. Claude Sonnet relabels each
// question's genre, region and decade and names its topic (100 a turn, about 50 turns), and groups
// questions on the same subject by region and by genre (10 turns a round). A question's decade is
// relabelled in place. A question in the wrong genre or region moves to the cell it belongs in when
// that cell has a free slot of its format, or is dropped; of a group on one subject, one is kept.
// Opus then fills the free slots (one turn per cell a round, up to --rounds, default 8), strictly in the cell's
// genre and avoiding every subject the genre already holds, and its questions are checked the same
// way. Kept questions keep their slots, so their ids do not change. A full run is a few hundred turns.
//
// Every reply is cached (default: <tmpdir>/trivia-questions-cache), so a rerun resumes where it stopped.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const GENRES = ["music", "film", "sport", "science", "history", "geography"];
const REGIONS = ["global", "au", "uk", "us"];
const PER_CELL = 40;
const CHOICE = PER_CELL / 2;
const CONCURRENCY = 4;
const ATTEMPTS = 3;
const MODELS = ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5"];
const CHECKER = "anthropic/claude-sonnet-5-5";
let MODEL = MODELS[0];
const DECADES = ["1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s"];
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../mcp/trivia-bank/questions.jsonl");
// The bank as cells of questions, kept on disk one question per line in its cell's order.
const toLines = (cells) =>
  Object.entries(cells)
    .flatMap(([cell, qs]) => qs.map((q) => JSON.stringify({ cell, ...q })))
    .join("\n") + "\n";
const fromLines = (source) => {
  const cells = {};
  for (const line of source.split("\n").filter((l) => l.trim())) {
    const { cell, ...q } = JSON.parse(line);
    (cells[cell] ??= []).push(q);
  }
  return cells;
};
const { values: flags } = parseArgs({
  options: {
    cache: { type: "string" },
    validate: { type: "boolean" },
    "per-cell": { type: "string", default: "60" },
    rounds: { type: "string", default: "8" },
  },
});
const TARGET = Number(flags["per-cell"]);
const ROUNDS = Number(flags.rounds);
const CACHE = flags.cache ?? join(tmpdir(), "trivia-questions-cache");

const REGION_TEXT = {
  global: "general knowledge from anywhere in the world",
  au: "Australia (Australian people, places, events and culture)",
  uk: "the United Kingdom (British people, places, events and culture)",
  us: "the United States (American people, places, events and culture)",
};
const LEVEL = {
  1: "very easy: a casual pub regular gets it",
  2: "easy: most regulars get it",
  3: "medium: a keen quizzer gets it",
  4: "hard: only strong quiz teams get it",
  5: "very hard: specialist knowledge",
};

const prompt = (genre, region, difficulty) =>
  `Write ${PER_CELL + 4} pub trivia questions for a lively quiz night.
Genre: ${genre}. Subject: ${REGION_TEXT[region]}. Difficulty ${difficulty} of 5 (${LEVEL[difficulty]}).
Be creative and varied: surprising angles, odd connections, wordplay where it fits, not textbook recall.
Every question must still be factual, unambiguous, with exactly one correct answer; use only facts you are certain of.
No two questions alike. Tie each to the decade from 1960s to 2020s that it is about, spread across the decades.
Make ${CHOICE + 2} multiple choice: {"format": "choice", "text", "options": [4 strings, plausible distractors, the answer among them once], "answer": the correct option's exact text, "decade"}.
Make ${CHOICE + 2} short answer: {"format": "short", "text", "answer": a single word or a few words, "decade"}.
decade is one of ${DECADES.map((d) => `"${d}"`).join(", ")}.
Output ONLY a JSON array of the objects, no prose, no code fence.`;

const PI_ENV = { ...process.env };
delete PI_ENV.ANTHROPIC_API_KEY;
delete PI_ENV.OPENAI_API_KEY;
delete PI_ENV.ANTHROPIC_AUTH_TOKEN;

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "pi",
      args,
      { cwd, env: PI_ENV, maxBuffer: 16 * 1024 * 1024, timeout: 600_000 },
      (err, stdout) =>
        err ? reject(Object.assign(err, { stdout })) : resolve(stdout),
    );
    child.stdin.end(); // pi -p waits on an open stdin
  });
}

async function pi(message, model = MODEL) {
  const cwd = await mkdtemp(join(tmpdir(), "trivia-pi-"));
  try {
    return await run(
      [
        "-p",
        "--model",
        model,
        "--thinking",
        "low",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-mcp",
        "--no-session",
        "--no-prompt-templates",
        "--no-themes",
        message,
      ],
      cwd,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

let turns = 0;

/** A Pi reply, cached by its prompt so a rerun resumes; a reply `parse` rejects is asked again. */
async function asked(message, model, parse, key = message) {
  const file = join(
    CACHE,
    "replies",
    `${hash(`${model}\u0000${key}`).toString("hex")}.txt`,
  );
  try {
    return parse(await readFile(file, "utf8"));
  } catch {}
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    turns++;
    try {
      const reply = await pi(message, model);
      const out = parse(reply);
      await writeFile(file, reply);
      return out;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// The JSON array in a reply, even when prose (with brackets of its own) follows it.
const jsonArray = (reply) => {
  const start = reply.indexOf("[");
  if (start < 0) throw new Error("no JSON array in reply");
  for (
    let end = reply.lastIndexOf("]");
    end > start;
    end = reply.lastIndexOf("]", end - 1)
  ) {
    try {
      const out = JSON.parse(reply.slice(start, end + 1));
      if (Array.isArray(out)) return out;
    } catch {}
  }
  throw new Error("no JSON array in reply");
};

async function pool(items, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

const hash = (s) => createHash("sha256").update(s).digest();

/** The options in a stable order of their own, so the answer's position carries no pattern. */
const shuffle = (text, options) =>
  [...options].sort((x, y) =>
    Buffer.compare(hash(`${text}\u0000${x}`), hash(`${text}\u0000${y}`)),
  );

// A question the model revised mid-text ("... no: which ...", two questions in one) reads badly aloud.
const REVISED =
  /(\.\.\.|…|—|–|\?|:)\s*(no|wait|actually|rather|simpler|scratch|correction|let me|hmm|oops|instead|hold on)\b|\bno wait\b|\(not allowed\)/i;
const revised = (text) => REVISED.test(text) || text.split("?").length > 2;

const valid = (q) => {
  if (
    typeof q?.text !== "string" ||
    typeof q?.answer !== "string" ||
    !DECADES.includes(q.decade)
  )
    return null;
  const text = q.text.trim();
  const answer = q.answer.trim();
  if (!text || !answer || revised(text)) return null;
  if (q.format === "short")
    return { format: "short", text, answer, decade: q.decade };
  if (
    q.format !== "choice" ||
    !Array.isArray(q.options) ||
    q.options.length !== 4
  )
    return null;
  const options = q.options.map((o) => (typeof o === "string" ? o.trim() : ""));
  if (
    options.some((o) => !o) ||
    new Set(options).size !== 4 ||
    !options.includes(answer)
  )
    return null;
  return {
    format: "choice",
    text,
    options: shuffle(text, options),
    answer,
    decade: q.decade,
  };
};

/** The cell's questions, CHOICE of each format interleaved, when the reply holds enough valid, distinct ones. */
export function parseCell(reply) {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("no JSON array in reply");
  const seen = new Set();
  const by = { choice: [], short: [] };
  for (const item of JSON.parse(reply.slice(start, end + 1))) {
    const q = valid(item);
    const key = q?.text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (!q || seen.has(key)) continue;
    seen.add(key);
    by[q.format].push(q);
  }
  if (by.choice.length < CHOICE || by.short.length < CHOICE)
    throw new Error(
      `only ${by.choice.length} choice and ${by.short.length} short valid questions`,
    );
  return Array.from({ length: CHOICE }, (_, i) => [
    by.choice[i],
    by.short[i],
  ]).flat();
}

async function cell(genre, region, difficulty) {
  const key = `${genre}-${region}-${difficulty}`;
  const file = join(CACHE, `${key}.json`);
  try {
    return [key, parseCell(await readFile(file, "utf8"))];
  } catch {}
  let last;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    turns++;
    await appendFile(join(CACHE, "turns.log"), `${key} ${attempt}\n`);
    try {
      const questions = parseCell(await pi(prompt(genre, region, difficulty)));
      await writeFile(file, JSON.stringify(questions, null, 1));
      console.log(`${key}: ok (attempt ${attempt})`);
      return [key, questions];
    } catch (e) {
      last = e;
      console.warn(`${key}: attempt ${attempt} failed: ${e.message}`);
    }
  }
  throw new Error(`${key}: ${last?.message}`);
}

async function generate() {
  const results = new Map();
  const failed = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < cells.length) {
        const [g, r, d] = cells[next++];
        try {
          const [key, qs] = await cell(g, r, d);
          results.set(key, qs);
        } catch (e) {
          failed.push(e.message);
        }
      }
    }),
  );
  if (failed.length) {
    console.error(`failed cells (rerun to retry):\n${failed.join("\n")}`);
    process.exit(1);
  }
  const ordered = Object.fromEntries(
    cells.map(([g, r, d]) => `${g}-${r}-${d}`).map((k) => [k, results.get(k)]),
  );
  await writeFile(OUT, toLines(ordered));
  console.log(`wrote ${cells.length} cells to ${OUT}`);
}

const GENRE_TEXT = {
  music: "songs, artists, bands, albums, instruments",
  film: "films, television, actors, directors",
  sport: "sports, athletes, teams, competitions",
  science: "science, technology, nature, medicine, space",
  history: "events, politics, leaders, wars, royalty, social history",
  geography: "places, landmarks, landforms, countries, cities, maps",
};

/** Each question's genre, region, decade and topic, as the checker reads them. */
async function classify(entries) {
  const batches = [];
  for (let i = 0; i < entries.length; i += 100)
    batches.push(entries.slice(i, i + 100));
  await pool(batches, async (batch) => {
    const message = `Classify each pub quiz question below. For each give:
- genre: the ONE knowledge area a team needs to answer it, one of: ${GENRES.map((g) => `${g} (${GENRE_TEXT[g]})`).join("; ")}.
- region: "au", "uk" or "us" when answering needs knowledge of Australia, the United Kingdom or the United States in particular, else "global".
- decade: the decade its subject belongs to, one of ${DECADES.map((d) => `"${d}"`).join(", ")} (the nearest when it falls outside them).
- topic: the specific subject or fact asked, in at most 6 words.
Questions, one per line as index|question|answer:
${batch.map((e, i) => `${i}|${e.q.text}|${e.q.answer}`).join("\n")}
Output ONLY a JSON array with one {"i": index, "genre", "region", "decade", "topic"} per question, no prose, no code fence.`;
    const out = await asked(message, CHECKER, (reply) => {
      const rows = jsonArray(reply);
      const by = new Map(rows.map((r) => [Number(r?.i), r]));
      // An unreadable row leaves its question unclassified, which drops it; many fail the reply.
      const out = batch.map((_, i) => {
        const r = by.get(i);
        if (
          !GENRES.includes(r?.genre) ||
          !REGIONS.includes(r.region) ||
          !DECADES.includes(r.decade) ||
          typeof r.topic !== "string"
        )
          return null;
        return {
          genre: r.genre,
          region: r.region,
          decade: r.decade,
          topic: r.topic,
        };
      });
      if (out.filter((c) => !c).length > batch.length / 10)
        throw new Error("too many unreadable rows");
      return out;
    });
    batch.forEach((e, i) => (e.cls = out[i]));
  });
}

const fits = (e) =>
  !!e.cls && e.cls.genre === e.genre && e.cls.region === e.region;

/** Groups of entries on one subject, read by the checker within each region and within each genre. */
async function sameSubjects(entries) {
  const scopes = [
    ...REGIONS.map((r) => entries.filter((e) => e.region === r)),
    ...GENRES.map((g) => entries.filter((e) => e.genre === g)),
  ];
  const groups = [];
  await pool(scopes, async (scope) => {
    const message = `Below are pub quiz questions, one per line as index|topic|question.
List every group of two or more that ask about the same specific subject, fact or event, so a team would
meet the same thing twice (not merely the same famous person, band or country asked about different facts).
${scope.map((e, i) => `${i}|${e.cls.topic}|${e.q.text}`).join("\n")}
Output ONLY a JSON array of groups, each an array of indexes; [] when there are none. No prose, no code fence.`;
    const found = await asked(message, CHECKER, (reply) =>
      jsonArray(reply).map((g) => {
        if (!Array.isArray(g) || g.some((i) => !scope[i]))
          throw new Error("bad group");
        return g.map((i) => scope[i]);
      }),
    );
    groups.push(...found.filter((g) => new Set(g).size > 1));
  });
  return groups;
}

async function validate() {
  const source = await readFile(OUT, "utf8");
  const bank = fromLines(source);
  // The state after each round, so a rerun resumes from the last round rather than redoing it.
  const checkpoint = join(CACHE, "validate-state.json");
  const sourceHash = hash(`${TARGET}\u0000${source}`).toString("hex");
  const saved = await readFile(checkpoint, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const labels = (list) =>
    `genre ${list.filter((e) => e.cls.genre !== e.genre).length}, region ${list.filter((e) => e.cls.region !== e.region).length}, decade ${list.filter((e) => e.cls.decade !== e.q.decade).length} of ${list.length}`;
  const cellOf = (s) => `${s.genre}-${s.region}-${s.difficulty}`;
  if (saved?.source === sourceHash) return refill(saved);
  // One slot per question; a slot keeps its format, so each cell stays half multiple choice.
  const slots = cells.flatMap(([genre, region, difficulty]) =>
    bank[`${genre}-${region}-${difficulty}`].map((q) => ({
      genre,
      region,
      difficulty,
      format: q.format,
      q,
    })),
  );
  const entries = slots.map((s) => ({ ...s }));
  await classify(entries);
  console.log(`mismatched labels before: ${labels(entries)}`);
  const clsOf = new Map(entries.map((e) => [e.q, e.cls]));

  const dropped = new Set();
  for (const group of await sameSubjects(entries)) {
    const keep = group.find((e) => fits(e) && !dropped.has(e)) ?? group[0];
    for (const e of group) if (e !== keep) dropped.add(e);
  }
  console.log(`same-subject duplicates dropped: ${dropped.size}`);
  slots.forEach((s, i) => {
    if (dropped.has(entries[i]) || !fits(entries[i])) s.q = null;
  });
  let moved = 0;
  for (const e of entries) {
    if (fits(e) || dropped.has(e) || !e.cls) continue;
    const slot = slots.find(
      (s) =>
        !s.q &&
        s.genre === e.cls.genre &&
        s.region === e.cls.region &&
        s.difficulty === e.difficulty &&
        s.format === e.format,
    );
    if (!slot) continue;
    slot.q = e.q;
    moved++;
  }
  console.log(`mismatches moved to their cell: ${moved}`);
  // Top each cell up to TARGET with free slots, half of each format.
  for (const [genre, region, difficulty] of cells) {
    const cell = slots.filter(
      (s) =>
        s.genre === genre && s.region === region && s.difficulty === difficulty,
    );
    let choice = cell.filter((s) => s.format === "choice").length;
    for (let n = cell.length; n < TARGET; n++) {
      const format = choice < TARGET / 2 ? "choice" : "short";
      if (format === "choice") choice++;
      slots.push({ genre, region, difficulty, format, q: null });
    }
  }

  await refill({
    source: sourceHash,
    before: labels(entries),
    round: 0,
    slots: slots.map((s) => ({ ...s, cls: s.q ? clsOf.get(s.q) : null })),
  });

  async function refill(state) {
    console.log(`resuming after round ${state.round}`);
    const slots = state.slots.map(({ cls, ...s }) => s);
    const clsOf = new Map(
      state.slots.filter((s) => s.q).map((s) => [s.q, s.cls]),
    );
    const save = (round) =>
      writeFile(
        checkpoint,
        JSON.stringify({
          ...state,
          round,
          slots: slots.map((s) => ({ ...s, cls: s.q ? clsOf.get(s.q) : null })),
        }),
      );
    await save(state.round);
    // A question asked twice (a move can bring in one the cell already holds) frees its later slot,
    // as does one the model revised mid-text.
    const seenText = new Set();
    for (const s of slots) {
      const key = s.q?.text.toLowerCase();
      if (!key) continue;
      if (seenText.has(key) || revised(s.q.text)) s.q = null;
      seenText.add(key);
    }
    const kept = () =>
      slots.filter((s) => s.q).map((s) => ({ ...s, cls: clsOf.get(s.q) }));
    // The topic ledger: every kept subject by genre, given to each generation as subjects not to use,
    // and grown as each reply lands so cells generated later in a round avoid it too.
    const ledger = new Map(GENRES.map((g) => [g, new Set()]));
    for (const e of kept()) ledger.get(e.genre).add(e.cls.topic.toLowerCase());
    for (let round = state.round + 1; round <= ROUNDS; round++) {
      const open = cells
        .map(([genre, region, difficulty]) =>
          slots.filter(
            (s) =>
              !s.q &&
              s.genre === genre &&
              s.region === region &&
              s.difficulty === difficulty,
          ),
        )
        .filter((free) => free.length)
        // Interleaved by genre, so the cells generated at once seldom share a genre.
        .sort(
          (a, b) =>
            a[0].region.localeCompare(b[0].region) ||
            a[0].difficulty - b[0].difficulty ||
            GENRES.indexOf(a[0].genre) - GENRES.indexOf(b[0].genre),
        );
      console.log(
        `round ${round}: ${open.reduce((n, f) => n + f.length, 0)} free slots in ${open.length} cells`,
      );
      if (!open.length) break;
      const byCell = new Map();
      await pool(open, async (free) => {
        const { genre, region, difficulty } = free[0];
        const need = {
          choice: free.filter((s) => s.format === "choice").length,
          short: free.filter((s) => s.format === "short").length,
        };
        const more = (n) => (n ? Math.ceil(n * 1.2) + 1 : 0);
        const avoid = [...ledger.get(genre)];
        const message = `${prompt(genre, region, difficulty).split("\n").slice(1, 5).join("\n")}
The genre is strict: every question must need ${genre} knowledge (${GENRE_TEXT[genre]}), not another genre's.${region === "global" ? " No question may need knowledge of Australia, the UK or the US in particular." : ` Every question must need knowledge of ${REGION_TEXT[region]}.`}
Every question on its own distinct subject; skip the best-known quiz staples.
Write each question in its final form: never revise or restart one inside its text.
Make ${more(need.choice)} multiple choice: {"format": "choice", "text", "options": [4 strings, plausible distractors, the answer among them once], "answer": the correct option's exact text, "decade", "topic"}.
Make ${more(need.short)} short answer: {"format": "short", "text", "answer": a single word or a few words, "decade", "topic"}.
decade is one of ${DECADES.map((d) => `"${d}"`).join(", ")}; topic is the question's subject in at most 6 words.
Do not use these subjects, already in the bank:
${avoid.join("\n")}
Output ONLY a JSON array of the objects, no prose, no code fence.`;
        const items = await asked(
          message,
          MODEL,
          (reply) => jsonArray(reply),
          `fill\u0000${round}\u0000${genre}-${region}-${difficulty}\u0000${need.choice}\u0000${need.short}`,
        );
        const got = [];
        byCell.set(free, got);
        for (const item of items) {
          const q = valid(item);
          if (!q) continue;
          if (typeof item.topic === "string")
            ledger.get(genre).add(item.topic.toLowerCase());
          got.push({ genre, region, difficulty, format: q.format, q, free });
        }
      });
      const fresh = open.flatMap((free) => byCell.get(free));
      await classify(fresh);
      const candidates = fresh.filter(fits);
      const pool2 = [...kept(), ...candidates];
      const lose = new Set();
      for (const group of await sameSubjects(pool2)) {
        const keep = group.find((e) => !candidates.includes(e)) ?? group[0];
        for (const e of group)
          if (e !== keep && candidates.includes(e)) lose.add(e);
      }
      const texts = new Set(kept().map((e) => e.q.text.toLowerCase()));
      for (const c of candidates) {
        if (lose.has(c) || texts.has(c.q.text.toLowerCase())) continue;
        const slot = c.free.find((s) => !s.q && s.format === c.format);
        if (!slot) continue;
        slot.q = c.q;
        clsOf.set(c.q, c.cls);
        ledger.get(c.genre).add(c.cls.topic.toLowerCase());
        texts.add(c.q.text.toLowerCase());
      }
      await save(round);
    }
    const left = slots.filter((s) => !s.q).length;
    if (left) {
      console.error(
        `${left} slots still free; rerun --validate with more --rounds (cached rounds are free)`,
      );
      process.exit(1);
    }
    const final = kept();
    console.log(`mismatched labels before: ${state.before}`);
    console.log(
      `mismatched labels after (decade relabelled): ${labels(final)}`,
    );
    for (const s of slots) s.q = { ...s.q, decade: clsOf.get(s.q).decade };
    const out = Object.fromEntries(
      cells.map(([g, r, d]) => [`${g}-${r}-${d}`, []]),
    );
    for (const s of slots) out[cellOf(s)].push(s.q);
    await writeFile(OUT, toLines(out));
    console.log(`wrote ${cells.length} checked cells to ${OUT}`);
  }
}

const auth = JSON.parse(
  await run(
    ["auth", "check", "--provider", "anthropic", "--json"],
    tmpdir(),
  ).catch((e) => e.stdout || "{}"),
);
if (auth.status !== "ready" || auth.authType !== "oauth") {
  console.error(
    `Pi has no ready Anthropic sign-in (${JSON.stringify(auth)}); run \`pi auth login anthropic\` first.`,
  );
  process.exit(1);
}
await mkdir(join(CACHE, "replies"), { recursive: true });
try {
  turns++;
  await pi("Reply with exactly: OK");
} catch {
  MODEL = MODELS[1];
}
console.log(`model: ${MODEL}`);
const cells = GENRES.flatMap((g) =>
  REGIONS.flatMap((r) => [1, 2, 3, 4, 5].map((d) => [g, r, d])),
);
if (flags.validate) await validate();
else await generate();
console.log(`Pi turns this run: ${turns}`);
