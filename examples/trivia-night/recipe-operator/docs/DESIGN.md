# trivia-host: design

## Part A: the brief

The trivia host works in a chat with a venue's trivia master, the person who runs pub quiz night at that venue. The host picks each round's questions from the question bank. It gives them to the trivia master, who reads them out to the room. After each round, the trivia master types in every team's answers. The host has the bank score the round, reads back the bank's summary of how the room did, and picks the next round. Each venue has its own crowd, its own region (Australia, the UK or the US) and its own favourite genres.

A good night has rounds that land near two in three answers right, mostly in genres the crowd likes, and no questions that only people from another country would know. A bad night has rounds that are far too easy or too hard, genres the crowd doesn't care for, or questions from another country.

At the start of each night the host states its plan: the genres it will use and the difficulty it will start at. It changes difficulty only between rounds, never during one, and by one level at a time (the bank rates difficulty from 1 to 5).

The host gets better at a venue week after week by keeping notes for that venue. Each venue owns its notes. Facts, such as questions, answers and scores, live in the bank. Judgement goes in the notes, and only judgement that will change what the host picks next week: which genres land, which difficulty to start at, and which genres or levels fall flat. A request for one night ("make tonight a Christmas round") is never saved as a lasting preference. The notes never hold team names, scores or the questions that were asked.

The host never makes up questions or answers. Every question comes from the bank and the bank does all the scoring. If the bank fails, the host tells the trivia master and doesn't guess.

### Assumed defaults

- **The question bank is faked** for this first version, since the real one isn't connected yet. The fake offers the bank's three functions: list questions by genre, region and difficulty; score a round's answers; and summarise a round.
- **"Only another country would know"** means a question tagged for a region other than the venue's. Questions tagged as general or international are fine everywhere.
- **The night's format:** the trivia master says how many rounds and how many questions per round. If they don't say, the host uses 4 rounds of 10 questions.
- **The first round's difficulty** comes from the venue's notes. A venue with no notes starts at 3.
- **"Near two in three"** means 55% to 75% right. Above 75%, the next round goes up one level. Below 55%, it goes down one level.
- **A new venue:** when there are no notes, the host asks the trivia master for the venue's region and favourite genres before planning the night.
- **The model:** Claude Opus 5.5 with low thinking, for quick replies in a live chat.

### Later cases (for improve)

- A new venue with no notes: the host asks for the region and genres, then plans the night.
- The bank goes down in the middle of a night.
- The trivia master disputes one of the bank's scores, or types in an answer spelled close to right.
- The trivia master asks the host to remember a team's name or its running total.
- A liked genre runs out of questions at the right region and difficulty.

## Exact values

- Model: `anthropic/claude-opus-5-5`, thinking level `low` (assumed default).
- Difficulty scale: 1 to 5, changed only between rounds, by at most one level.
- Target band: 55% to 75% of answers right (assumed default).

## Part B: how it is built

**Original.** The `template-starter` template from the introspection-recipes catalog (Apache-2.0), scaffolded 2026-11-22. No other base.

**Behaviours and capabilities.**

| Item                                                                                                        | Kind                                                               | Needed by  |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------- |
| State the night's plan (genres, starting level, why) before any question                                    | instruction (`SYSTEM.md`)                                          | C1, C2     |
| One level per round; change only between rounds, one level at a time, from the 55% to 75% band              | instruction                                                        | C1, C2, C3 |
| Only the venue's region or `general`; never fill from another country or with own questions                 | instruction                                                        | C1, C3     |
| Score and summarise through the bank, never by hand                                                         | instruction + `question-bank` MCP (`score_round`, `round_summary`) | C1         |
| Pick questions from the bank                                                                                | `question-bank` MCP (`list_questions`)                             | C1, C2, C3 |
| Venue notes in `memories/notes.md`, read at the start, rewritten at the end, under the owner's memory rules | memory block in `SYSTEM.md` + `read`, `write`, `edit`              | C2         |

**Cut.** `bash` (no case needs a shell; the notes need only read and write), `show_artifact` (nothing is a file for people), skills (the rules fit in `SYSTEM.md`).
**Custom code.** None in the Recipe. The bank fake and its synthetic supply under `fakes/` are for development only.

**Data during development.**

- `question-bank` (C1, C2, C3) is faked in `fakes/mcp/question-bank/`. The real server isn't bound yet, so there is no captured contract. As the owner asked, the fake is built on a **provisional `tools.ts` written by hand** from the owner's description (list by genre, region and difficulty; score a round; summarise a round), against the workflow's rule that only `introspection bindings mcp capture` writes it. Tool names, arguments and answer shapes are approximated. Deploy-connect must bind the real server, capture its contract over this file, and rewrite the handlers and answers to it; the cases then need a fresh run. The server is declared `required: false` with `discovery: defer` until then; deploy makes it required.
- What the fake models: questions the venue has had scored are never listed again; answers are hidden until scoring; answers are matched case- and punctuation-insensitively. It does not model: fuzzy or alternative answers, disputes, outages, pagination past 30.
- The supply is synthetic and generated (`fakes/scenarios/bank.ts`): 10 genres × 4 regions (general, AU, UK, US) × 5 levels, 16 to 24 per cell. Question text is a placeholder; nothing scored depends on it. Scenario `us-sport-scarce` (C3) leaves three US and two general sport questions per level.

**How each case is checked.**

| ID  | Method                                                                     | Where                                                               |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| C1  | code (checks in `runs/harness/check.mjs` for now; improve writes the eval) | Pi run against the `base` scenario, notes seeded                    |
| C2  | code                                                                       | two Pi runs, the second from the first's `memories/` and bank state |
| C3  | code, plus a person on the explanation                                     | Pi run against `us-sport-scarce`, notes seeded                      |

**Results.** Run locally on 2026-11-22 against the bank fake, each night a whole conversation with a person playing the trivia master (a fresh subagent given only the situation). All code checks pass:

- **C1 pass.** Plan (music and film, level 3) stated before the first question; four rounds, one level each (3, 4, 4, 4); round two at level 4 after round one came back 90%; every question UK or general and from the bank; mostly music and film, no sport; every round scored by the bank.
- **C2 pass.** Night 1: rounds at 2, 3, 3, 3, all AU or general; the notes afterwards hold no team names, team scores, questions or Christmas preference. Night 2 (a new chat, the same notes and bank state): plan starts at level 3, all film and history, no Christmas round.
- **C3 pass (code checks); explanation for the owner to review.** Every question US or general, one level per round, all from the bank. With five usable sport questions per level, the host told the trivia master why at the start and filled the rest with music. Weak spots for review: it offered a level change the rules don't allow, then withdrew it, and promised sport in round three, then withdrew that too.

How the cases were run: a local task (`introspection tasks create`) always starts its folder fresh, so a venue's notes can't be in place before the first turn. C1, C2's second night and C3 need them. So each night ran in Pi directly (`pi --recipe trivia-host`), from a folder beside the repository with `memories/` seeded, the bank fake served with `eval-simulate serve`, and bound through `PI_RECIPES_MCP_LOCAL_CONFIG`. The harness and the checks are in `runs/harness/` beside the repository (not committed); improve turns them into evals.

**Fix found by the first run.** The agent's MCP block named no mode, so Recipes exposed the bank through its CLI, which needs a shell the host doesn't have; the host said it couldn't reach the bank. `mcp.mode: tools` declares the three tools to the model.

**Memory search (improve-memory m1, 2026-11-22, simulated in-session).** The memory block was searched as the Operator's improve-memory step says: three training venues and six held-out venues in a seeded simulation (`fakes/venues.ts`, `fakes/mcp/subject/`, `fakes/scoring.ts`), 3 nights of 3 rounds each. Candidates: the deployed block, three seed blocks (dated log, beliefs with evidence, settings file), and two meta-agent revisions that passed integrity review (beliefs with genres settled by results; settings with a per-level verdict). On the held-out venues neither finalist beat the deployed block by more than the paired standard error on any metric (rounds in range +0.06 and -0.04, SE about 0.09), so the deployed block is kept, as the owner asked. No candidate's notes broke the owner's memory rules. Known limits: the room's skill on two held-out venues reaches the bank's top level, so no host can land in range there; two broken measurements (a subagent reporting calls it never made) were rerun; world fixes made during the search are logged in the run's brief. The run's record is under `runs/improve-memory/m1/` (not committed).

**Change log.**

- 2026-11-22: brief and cases C1 to C3 approved by Julian Bright; model `anthropic/claude-opus-5-5`, thinking `low`, as an assumed default.
- 2026-11-22: first Recipe and the question-bank fake (provisional contract).
- 2026-11-22: eval-simulate 0.10.0 from npm; MCP mode set to tools; C1 to C3 pass locally.
- 2026-11-22: simulated venues, a trivia-master fake and scoring for the memory search; improve-memory m1 kept the deployed memory block (no candidate beat it on held-out venues).
