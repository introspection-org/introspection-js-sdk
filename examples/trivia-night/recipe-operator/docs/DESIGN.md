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

| Item                                                                                                 | Kind                                                           | Needed by  |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------- |
| Plan stated before round one, with reasons                                                           | instruction (`SYSTEM.md`, Running the night)                   | C1, C3     |
| One genre, one difficulty, own region or `global` per round                                          | instruction                                                    | C1, C3     |
| Whole answer sheet in one `submit_round`; never marks itself                                         | instruction                                                    | C1         |
| One level up or down between rounds (over 75% / under 58%)                                           | instruction                                                    | C1         |
| Tonight-only requests honoured and not kept                                                          | instruction + memory block                                     | C2         |
| Per-venue notes in `memories/notes.md`: country, tastes, start level; never teams, scores, questions | memory block (`<!-- memory:start -->` … `<!-- memory:end -->`) | C2, C3     |
| Trivia bank                                                                                          | connection: MCP `trivia-bank`, `mode: tools`, six tools        | C1, C2, C3 |
| `read`, `write`, `edit`                                                                              | tools, for the notes file                                      | C2, C3     |

**Cut.** `bash` (not needed once the bank's tools are exposed directly); `show_artifact` (the host makes no files).

**Custom code.** None in the Recipe.

**Data during development.** `trivia-bank` is faked in `fakes/mcp/trivia-bank/`. Its tools come from `introspection bindings mcp capture` on 2026-11-23. Every answer's shape is approximated from the tool descriptions, because the real bank hasn't been observed yet (no `observed.ts`). In particular, `submit_round`'s `correct_answer` per mark and the shape of `round_summary` are assumptions. Run `introspection bindings mcp observe trivia-bank` once real nights exist. Questions are synthetic placeholders: 12 per genre × region × level, with code-word answers. The fake relaxes only difficulty when a filter runs dry. Scenarios: base (a new venue), `returning` (week 4, film and music strong), `second-week` (sport and history strong).

**Model.** `anthropic/claude-opus-5-5`, thinking `low` (assumed default from brainstorm). `runtime.llm_mode: managed`, as the owner chose.

**How each case is checked.**

| ID  | Method         | Where                                                                                |
| --- | -------------- | ------------------------------------------------------------------------------------ |
| C1  | code (planned) | needs the venue's notes before the first turn; runs in the memory-series runner      |
| C2  | code (planned) | two nights in a row for one venue; runs in the memory-series runner                  |
| C3  | person         | first night run as local task `runs/C3-2`; weeks 2 and 3 in the memory-series runner |

**Results.**

- `runs/C3-1` failed before reaching the bank. In CLI mode the tools sat behind a shell command the instructions never named. Fixed by switching to `mode: tools` (7329e29). The plan in that run also used genres the bank lacks; fixed by naming the six genres.
- `runs/C3-2`, first night at a Manchester venue, rounds 1–2. The host read the empty notes and stated a plan. It called `start_night` and `register_teams`, then fetched music / `uk` / level 3. It submitted all 24 answers in one call. After 20 of 24 (83%) it moved round 2 up exactly one level (sport / `uk` / 4). The plan went out as text before round one, but the final reply shows only the round. A person should check whether the plan's "why" is clear enough. One turn was sent twice because I re-sent a cancelled prompt; the host noticed and submitted once.
- Local tasks can't start with a venue's notes already in place, so C1 and C2, and C3's later weeks, are planned for the in-session memory-series runner (improve-memory).

**Change log.**

- 2026-11-23: first draft; switched MCP to `mode: tools`; named the bank's genres.
