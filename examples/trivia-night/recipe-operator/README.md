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

Harbor tasks check that the host keeps a venue's notes from one night to the next. Each night is a trial against the bank's fakes (`fakes/`, served as a sidecar, with the venue's profile as its scenario); its notes come back as the trial's `memories` artifact.

| Task     | Night                                 | Where memory comes from                     |
| -------- | ------------------------------------- | ------------------------------------------- |
| `night0` | none: seeds a pub's true notes        | the trivia master's notes, word for word    |
| `night1` | first night at a new pub              | none: it writes `memories/MEMORY.md`        |
| `night2` | the next night there, on the platform | its own memory, another pub's, seeded, none |

**On the platform** the three tasks in `evals/harbor/` are all there is, and each trial says which pub it plays: the task's metadata names it (`trivia_night.trial`: `pub`, `night`, `teams`), its prompt is the pub's instruction, and its compose gives the bank sidecar the pub's crowd. The verifier (`tests/check.mjs`) reads the trial from `INTROSPECTION_TASK_METADATA_JSON` and the pub's truth from `evals/venues.json` (or `evals/heldout.json`), and scores it with `evals/trivia-check.mjs`. `evals/trivia-tasks.mjs` holds the instructions, the truth and the bank's settings, for the page, the verifiers and the generator alike. Without that metadata the verifier reads `TRIVIA_PUB`, `TRIVIA_NIGHT` and `TRIVIA_TEAMS` (5 by default) from its environment, which a task's `[verifier] env` in `task.toml` can set.

**In plain Harbor** a task's `tests/` is all the sandbox gets, so it cannot reach `venues.json`. Generate a self-contained task per pub, night and crowd size first, each with its instruction, compose, `tests/expected.json` and a copy of the shared verifier, then run one:

```sh
node evals/venues.mjs            # into evals/harbor/, beside the three committed tasks; git ignores them
harbor run --path evals/harbor/night1-melbourne
introspection eval run --path evals/harbor/night1-melbourne
```

`venues.mjs` also writes `evals/venues.json` and `evals/heldout.json` from the profiles in `fakes/world/profiles.ts`: Sydney, Melbourne, Brisbane and Perth in Australia; Manchester, Leeds, Bristol and Glasgow in the UK; Chicago, Boston and Seattle in the US, and the held-out pubs. Commit those after changing a profile; nothing it generates under `evals/harbor/` is committed.

Night 2 recalls night 1 only for the same identity. Use a new `<run>` each time, since an identity keeps its memory.

The key that created an anonymous identity can't read that user's conversation, so each trial is scored in its sandbox: the runtime keeps the conversation's GenAI spans at `/tmp/introspection/genai-spans.json` for an eval task, and the native adapter builds the verifier's `trajectory.json` from them (the trial's result records `trajectory_source: "sandbox"`). The verifiers read only the agent's own steps, since the system prompt itself tells the agent to ask for the country.

## Next iteration

Run the memory search from a weaker block, then run the cases against the real bank as well as the fake.
