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

## Run the memory evals

Three Harbor tasks check that the host keeps a venue's notes from one night to the next. Each night is a trial against the bank's fakes (`fakes/`, served as a sidecar); its notes come back as the trial's `memories` artifact.

| Task            | Night                           | Where memory comes from                           |
| --------------- | ------------------------------- | ------------------------------------------------- |
| `night1-memory` | first night at a new venue      | none: it writes `memories/MEMORY.md`              |
| `night2-memory` | the next night, local Docker    | night 1's notes, mounted by `evals/run-series.sh` |
| `night2-hosted` | the next night, on the platform | the identity's own memory                         |

**Local Docker.** Runs the Recipe in the Runtime image with your own model key:

```sh
export ANTHROPIC_API_KEY=...   # read by the tasks' [environment.env]
./evals/run-series.sh          # night 1, then night 2 from its notes
```

**On the platform.** Memory is kept per identity only for tasks an agent creates, so run as a staging key that expires today, and give each series its own anonymous identity:

```sh
introspection api-keys create --environment staging --capabilities runtimes,evals \
  --expires-at <today, 23:59 UTC> --secret-file .agent.key
export INTROSPECTION_TOKEN="$(cat .agent.key)"
export INTROSPECTION_DP_URL="$(introspection whoami --query dp_url -o table)"
for task in night1-memory night2-hosted; do
  introspection eval run -r <runtime version> --commit-sha <pushed commit> \
    --path evals/harbor/$task --identity anon:sim-venue-a-r1
done
introspection api-keys revoke <key id>
```

Night 2 recalls night 1 only for the same identity; a new identity starts with no notes and asks which country the venue is in. Each night runs and keeps its memory per identity today, but the trial isn't scored yet: the key that created the anonymous identity can't read its conversation back, so Harbor's ingest check times out.

## Next iteration

Run the memory search from a weaker block, then run the cases against the real bank as well as the fake.
