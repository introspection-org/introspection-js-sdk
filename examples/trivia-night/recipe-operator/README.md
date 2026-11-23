# Trivia host, built by the Operator

This Recipe is what a fresh Operator session built from the one prompt in [WALKTHROUGH.md](../WALKTHROUGH.md), with the owner answering from that script. It is kept beside the hand-built [`recipe/`](../recipe) as the version to hill-climb on: change the Operator's skills or the walkthrough, rebuild, and compare.

## What it has

- `SYSTEM.md`: the host's instructions, with its memory block between `<!-- memory:start -->` and `<!-- memory:end -->`.
- `agents/agent.yaml`: the agent, with the question bank's tools given to it directly (`mcp.mode: tools`).
- `evals/cases/C1.md` to `C3.md`: the approved cases. All three pass locally against the bank fake.
- `fakes/`: eval-simulate fakes of the question bank and the trivia master (`subject`), the seeded venue model (`venues.ts`), and the world checks (`tests/world.test.js`).
- `docs/DESIGN.md`: the brief, and in Part B the memory search and the case results.

## How it differs from `recipe/`

- **Its question bank is a contract it designed** (`list_questions`, `score_round`, `round_summary`), not this example's bank (`start_night`, `register_teams`, `next_questions`, `submit_round`, `round_summary`, `scoreboard`). The walkthrough never gave it the real bank's tools, so it runs only against its own fake.
- **Its memory search found no better block.** Its first block already kept settings (region, liked genres, a level per genre), and neither revision beat it on the held-out venues by more than the noise.

## Next iteration

Give build the real bank first: register it as an MCP connector in the project, so the Recipe and its fake take the bank's own tools. Then rebuild, start the search from a weaker memory block, and run C1 to C3 against the real bank as well as the fake.
