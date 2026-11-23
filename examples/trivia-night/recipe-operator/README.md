# Trivia host, built by the Operator

This Recipe is what a fresh Operator session built from the one prompt in [WALKTHROUGH.md](../WALKTHROUGH.md), with the owner answering from that script. It is kept beside the hand-built [`recipe/`](../recipe) as the version to hill-climb on: change the Operator's skills or the walkthrough, rebuild, and compare.

## What it has

- `SYSTEM.md`: the host's instructions, with its memory block between `<!-- memory:start -->` and `<!-- memory:end -->`.
- `agents/agent.yaml`: the agent, with the bank's tools given to it directly (`mcp.mode: tools`).
- `evals/cases/C1.md` to `C3.md`: the approved cases.
- `fakes/mcp/trivia-bank/`: an eval-simulate fake of this example's question bank. Its `tools.ts` was captured from the running bank by `introspection bindings mcp capture`, so it serves the bank's own six tools (`start_night`, `register_teams`, `next_questions`, `submit_round`, `round_summary`, `scoreboard`).
- `docs/DESIGN.md`: the brief, and in Part B the fakes, the local results and what is still open.

## How it was built

The owner told brainstorm the bank already runs as an MCP server, so the session connected it to the project before draft and captured its tools, instead of designing a contract. A first trial of C3's first night ran end to end against the fake. C1, C2 and C3's later weeks need a venue's notes in place before the night, which a local case can't yet start with, so they run in the memory search.

## Next iteration

Run the memory search from a weaker block, then run the cases against the real bank as well as the fake.
