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

Four Harbor tasks check that the host keeps a venue's notes from one night to the next. Each night is a trial against the bank's fakes (`fakes/`, served as a sidecar); its notes come back as the trial's `memories` artifact.

| Task             | Night                           | Where memory comes from                           |
| ---------------- | ------------------------------- | ------------------------------------------------- |
| `night1-memory`  | first night at a new venue      | none: it writes `memories/MEMORY.md`              |
| `night2-memory`  | the next night, local Docker    | night 1's notes, mounted by `evals/run-series.sh` |
| `night2-hosted`  | the next night, on the platform | the identity's own memory                         |
| `night2-control` | the next night, a new identity  | none: it must ask where the venue is              |

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
    --path evals/harbor/$task --identity anon:sim-<run>-venue-a
done
introspection eval run -r <runtime version> --commit-sha <pushed commit> \
  --path evals/harbor/night2-control --identity anon:sim-<run>-venue-b
introspection api-keys revoke --key <key id> --yes
```

Night 2 recalls night 1 only for the same identity; the control, a new identity, starts with no notes and must ask which country the venue is in. Use a new `<run>` each time, since an identity keeps its memory.

The key that created an anonymous identity can't read that user's conversation, so each trial is scored in its sandbox: the runtime keeps the conversation's GenAI spans at `/tmp/introspection/genai-spans.json` for an eval task, and the native adapter builds the verifier's `trajectory.json` from them (the trial's result records `trajectory_source: "sandbox"`). The verifiers read only the agent's own steps, since the system prompt itself tells the agent to ask for the country.

On the local stack all three pass, each scored from the sandbox:

| Trial            | Identity | Reward | What it shows                                                          |
| ---------------- | -------- | ------ | ---------------------------------------------------------------------- |
| `night1-memory`  | venue A  | 1      | notes hold the country, genres and difficulty, and no team names       |
| `night2-hosted`  | venue A  | 1      | a UK round at difficulty 3 in a genre not yet played; no country asked |
| `night2-control` | venue B  | 1      | asks the venue's country before fetching anything                      |

## Next iteration

Run the memory search from a weaker block, then run the cases against the real bank as well as the fake.
