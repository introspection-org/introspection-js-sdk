# Trivia host: design

## Part A: the brief

The trivia host runs a pub's weekly quiz night together with the venue's trivia master. The trivia master opens a chat at the start of the night. Every venue is its own end user on the platform, so the bank and the host's notes are kept separately for each venue. At the start the host says tonight's plan: the rounds, each round's genre and starting difficulty, and why. It then starts the night, registers the teams and gives the trivia master one round of questions at a time to read out. The answers aren't shown until the round is marked. The trivia master types in every team's answers. The host submits the whole sheet to the bank, which does all the marking, and then reports the marks, the answers and the standings. The host is getting it right when rounds land near two in three answers correct, most rounds come from genres the crowd likes, and no question needs knowledge only another country would have. It's getting it wrong when it marks answers itself, changes difficulty in the middle of a round or by more than one level, asks another country's local questions, or repeats a question. The host adapts only between rounds, one difficulty level at a time. It must never treat a request for tonight as a lasting preference. It must never write team names, scores or the questions asked into its notes. Facts (what was asked, how each genre and level went) live in the bank. Judgement (what this crowd enjoys, where to start, the venue's country) lives in the venue's notes, which belong to the venue.

**What it reaches:** the trivia bank MCP server (`trivia-bank`, https://trivia-bank.intro.dev/bank/mcp). It needs no key and tells venues apart by the platform's end-user token. Its tools are `start_night`, `register_teams`, `next_questions`, `submit_round`, `round_summary` and `scoreboard`, captured in `docs/trivia-bank-contract.json` on 2026-11-22.

**Who reads the output:** only the trivia master, in the chat, who reads the questions aloud. There is no second audience.

### Assumed defaults

- **Night shape:** 5 rounds of 8 questions, one genre per round, unless the trivia master says otherwise.
- **Adapting:** the target is 67% correct across the round. Above 75% the next round goes up one level, below 58% it goes down one, and otherwise it stays.
- **First night at a venue:** the host asks which country the venue is in, starts at difficulty 3 and plays a balanced mix of genres. After that, about 3 rounds in 5 come from the crowd's favourite genres.
- **Region:** the host asks only for the venue's own region and `global`.
- **Memory:** one notes file per venue. It's read at the start of each night and updated at the end, and it holds only what changes the next night's plan.
- **Model:** `anthropic/claude-opus-5-5`, thinking low, for quick replies during a live night.

### Later cases (for improve)

- The bank relaxes a filter because questions run dry. The host should say how.
- The trivia master types an answer sheet with a team missing, or with a typo in a team name.
- A team asks the host to re-mark an answer.
- A night is cut short after two rounds.
- The trivia master asks for a question that isn't in the bank, or asks the host to write one.

### Exact values

- Model: `anthropic/claude-opus-5-5`, thinking level `low` (assumed default).
- Bank server id: `trivia-bank`.

## Part B: how it is built

**Original.** `template-starter`, via `introspection init` on 2026-11-22. No other base.

**Behaviours and capabilities.**

| Item                                                                                                          | Kind                                                                                                             | Needed by  |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------- |
| Plan stated before round one, with reasons                                                                    | instruction (`SYSTEM.md`, Running the night)                                                                     | C1, C3     |
| One genre, one difficulty, own region or `global` per round                                                   | instruction                                                                                                      | C1, C3     |
| Round's level decided first, then its questions fetched once (every fetched question is used up at the venue) | instruction                                                                                                      | C1, C2     |
| Whole answer sheet in one `submit_round`; never marks itself                                                  | instruction                                                                                                      | C1         |
| One level up or down between rounds (over 75% / under 58%)                                                    | instruction                                                                                                      | C1         |
| Tonight-only requests honoured and not kept                                                                   | instruction + memory block                                                                                       | C2         |
| Per-venue notes in `memories/MEMORY.md`: country, tastes, start level; never teams, scores, questions         | memory block (`<!-- memory:start -->` … `<!-- memory:end -->`), the original block, kept after the memory search | C2, C3     |
| Trivia bank                                                                                                   | connection: MCP `trivia-bank`, `mode: tools`, six tools                                                          | C1, C2, C3 |
| `read`, `write`, `edit`                                                                                       | tools, for the notes file                                                                                        | C2, C3     |

**Cut.** `bash` (not needed once the bank's tools are exposed directly); `show_artifact` (the host makes no files).

**Custom code.** None in the Recipe.

**Data during development.** `trivia-bank` is faked in `fakes/mcp/trivia-bank/`. Its tools come from `introspection bindings mcp capture` on 2026-11-23. Every answer's shape is approximated from the tool descriptions, because the real bank hasn't been observed yet (no `observed.ts`). In particular, `submit_round`'s `correct_answer` per mark and the shape of `round_summary` are assumptions. Run `introspection bindings mcp observe trivia-bank` once real nights exist.

- **Questions:** synthetic placeholders, 200 per genre × region × level, built in code (`supply.ts`). That is sized so no series runs short; the real bank holds only 240 in total and never repeats a question at a venue.
- **Relaxing:** the fake relaxes only difficulty when a filter runs dry.
- **Simulated venues:** for the memory search and the cases, `fakes/world/` holds the simulated venues (`profiles.ts`: 3 training, 8 held-out, and the three case venues). `fakes/mcp/subject/` holds a scripted trivia master (`say`). In venue worlds the bank marks each answer from the venue's profile.
- **Scenarios:** base (a new venue), `returning`, `second-week`, one per venue, and `case-c1`/`case-c2`/`case-c3`.
- **Checks:** the world's own checks (replay, supply, can-tell, other-country, guards) are in `fakes/tests/world.test.js`.

**Model.** `anthropic/claude-opus-5-5`, thinking `low` (assumed default from brainstorm). `runtime.llm_mode: managed`, as the owner chose.

**Memory search (improve-memory m1, in-session, 2026-11-22/23).** The full record is in `evals/memory/RESULTS.md`; the scripts and decision outputs are alongside it.

- **Setup:** one fresh subagent played the host per night, against the fakes. Venues: 3 training venues × 4 nights and 8 held-out venues × 3 nights. Metric: off-target (|round correct rate − 2/3|, nights 2+). Guards: no team names, scores, standings or questions in the notes; no one-night request carried over; no other-country questions; and the owner's variety rule.
- **Round 1:** the control plus 4 seeds (freeform, dated log, beliefs, next-action notes). nextaction led; beliefs and nextaction were revised by a meta agent and reviewed. beliefs-rev (per-genre difficulty beliefs) was best on training, 0.125 against the control's 0.170. Held-out at seed 101 its gain was 1.4 SE; with a second seed, +0.013 at 2.01 SE, a borderline pass. It was adopted.
- **Variety guard:** the owner then set the variety rule: about 3 in 5 from liked genres, every genre still getting a turn, and no memory block may override it. beliefs-rev broke the first version of the guard on 5 nights, so it was withdrawn. The owner refined the guard: a night breaks it only when every round is in a genre the host already had reason to think liked (named by the trivia master, or loved in an earlier round there), with the request night excluded.
- **Round 2:** the variety rule was given to the meta agent as an owner's rule. Parents were freeform and beliefs; revisions were freeform-rev and beliefs-rev2. Neither beat its parent by more than the control's training spread (0.046) with no guard broken. freeform-rev was taken held-out anyway, as a training tie: G = +0.000 (0.03 SE), and the high venue was worse than the control's spread. It was not adopted.
- **Re-measure:** beliefs-rev with C3's fix (one difficulty line per genre, short profile) was measured on its exact wording, on new held-out runs at seeds 101 and 202: G = +0.011, SE 0.014 per venue (0.79 SE) and ±0.011 per run (1.0 SE). The high venue was worse by 0.062 against S = 0.057, and there was 1 variety break. It was not adopted.
- **Outcome:** no candidate passed the owner's adoption rule on fresh held-out runs, so the original memory block is kept. Any change to the memory section needs held-out confirmation under that rule again.

**How each case is checked.**

| ID  | Method        | Where                                                                                                                                                                           |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | code + person | memory-series runner, world `case-c1`, notes from `evals/cases/inputs/C1-notes-current`; checks `fakes/world/check-cases.ts C1`; plan and answer-holding read in the transcript |
| C2  | code          | memory-series runner, world `case-c2`, notes from `evals/cases/inputs/C2-notes-current`, two nights; checks `fakes/world/check-cases.ts C2`                                     |
| C3  | person + code | memory-series runner, world `case-c3`, three nights from no notes; checks `fakes/world/check-cases.ts C3`; plans and notes read by a person                                     |

**Results.**

On the current instructions, with the original memory block. These ran on 2026-11-23 in the memory-series runner; outputs are in `evals/memory/case-results/current/`.

- **First run, on the instructions as they were:**
  - C1 passed.
  - C3 passed.
  - C2 failed one property. On the birthday night the host fetched round 5 at level 2, then worked out from round 4's marks that the night should drop a level and fetched again at level 1. The first eight questions were used up at the venue without ever being read out, and the real bank never repeats a question. Fix, in the night instructions only: decide a round's level from the last round's marks first, then fetch once, because every fetched question is used up at the venue. The memory section is unchanged.
  - The beliefs block's one-difficulty-line-per-genre check also flagged C2. That check tested the withdrawn block's rule, not a case requirement, so it is now informational.
- **Rerun on the fixed instructions:**
  - **C1: pass.** All 9 code checks passed: the night started once before any questions; every round used one genre, one level and `au`/`global`; there was one fetch and one whole-sheet submit per round; round 1 at 100% led to round 2 at exactly one level higher (3→4). Person read: the plan, with its reasons (film and music for 3 of 5 because the notes say the crowd loves them), came before the night started, and no answer appeared before marking. The notes hold the country, tastes and a start level with its reason.
  - **C2: pass.** All code checks passed on both nights, with five fetches for five rounds each night. The birthday night was all music and said it was for tonight only. The next week was mostly sport and history. The notes after each night record the request as a one-off, don't name Dave, still name sport and history, and hold no teams, scores or questions. The plan came first on both nights. The notes do record that music "doesn't go down well here", from the room's flat reaction, which is judgement within the owner's rules.
  - **C3: pass.** All code checks passed on all three nights. Person read: night 1 was a balanced mix at level 3, UK and global only, and said it was a first night. Night 3 leaned on film (two rounds) with geography and varied rounds, and said why. The notes stayed short (6 lines: country, start level with reason, tastes, what is due a turn).
- **Held-out evidence:** the night-instruction change sits outside the memory section, but it does change how every night runs. The control's held-out series were run on the instructions before it.
- **Stand-in runner:** a subagent played the host from a brief with every memory file pasted in. The runtime loads only `memories/MEMORY.md` at session start, so the kept block's notes file was renamed from `notes.md` to `MEMORY.md` after the search, by the owner's decision, without a new held-out run. Confirming the block on the real runtime is still open.

Earlier history:

- `runs/C3-1` failed before reaching the bank. In CLI mode the tools sat behind a shell command the instructions never named. Fixed by switching to `mode: tools` (7329e29). The plan in that run also used genres the bank lacks; fixed by naming the six genres.
- `runs/C3-2`, first night as a local task: the host reached the bank, submitted the whole sheet in one call, and moved one level after an 83% round.
- Local tasks can't start with notes in place, so the cases run in the memory-series runner.
- C1 to C3 also passed on the withdrawn beliefs block. C3 needed its one-line-per-genre fix there; see `evals/memory/case-results/`.

**Change log.**

- 2026-11-22: first draft; switched MCP to `mode: tools`; named the bank's genres.
- 2026-11-23: beliefs-rev adopted under the owner's two-seed rule (2.01 SE), then refined for C3 (one difficulty line per genre, short profile).
- 2026-11-23: beliefs-rev withdrawn under the owner's variety guard, and the original memory block restored.
- 2026-11-23: second revision round; nothing qualified. freeform-rev measured held-out, no gain.
- 2026-11-23: beliefs-fix re-measured held-out on its exact wording. It failed the rule, so the original memory block is kept.
- 2026-11-23: night instructions: decide a round's level before fetching, and fetch once. C2 had fetched one round twice and used up eight unread questions. The memory section is unchanged.
- 2026-11-23: the kept block's notes file renamed from `memories/notes.md` to `memories/MEMORY.md`, which the runtime loads at session start. Not re-measured.
