# Trivia Night: a memory demo

A quiz host for pubs. The question bank never repeats a question at a venue, and a host that remembers the venue pitches each night to its crowd. The page runs the real memory evals on the platform and shows, as each trial runs, every bank call the agent makes and every read and write of its notes.

> **Status:** the bank and its MCP server run with no platform. `pnpm dev` also deploys the Recipe as the `trivia-host` Runtime and binds the bank to it on a public URL, and the agent calls the bank, but the bank does not yet accept the token the platform sends for it; [What's next](#whats-next) says why and what is missing.

## The point: improve

The sample exists to show one thing: the host starts with no memory, and the Operator's improve step changes the Recipe so it keeps and uses notes on each venue.

| Stage                   | What exists                                                                              | State                                               |
| ----------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------- |
| The agent to improve    | [`recipe/`](./recipe): a host that pitches every night at difficulty 3 and keeps nothing | Passes `introspection check`; `pnpm dev` deploys it |
| Evidence improve reads  | Each night's conversation, the venue's complaint afterwards, and the bank's results      | Not built                                           |
| What improve may change | The `## Memory` block in `recipe/SYSTEM.md`, a notes file, a skill for pitching a night  | Not built                                           |
| Proof the change worked | The memory evals, run from the page                                                      | Built                                               |

Improve works on single conversations today, and memory spans several. So each memory case is one conversation with the venue's notes already in place: a **read** case checks that tonight's plan follows the notes, and a **write** case checks that the notes exist after a night.

## Run it

You need Node 22 or later, pnpm, and cloudflared (`brew install cloudflared`).

```bash
pnpm install
```

```bash
pnpm dev
```

It serves the page on `http://localhost:3500`, and the bank's MCP server alone on `127.0.0.1:3501` behind a free Cloudflare quick tunnel, new each run. The page and `/api/*` are never on the tunnel. On whichever stack `introspection login` chose (staging, production or your own) it then sets up, and on a later run only checks:

1. the `trivia-host` Runtime: a repository Introspection hosts, seeded from a copy of [`recipe/`](./recipe) in `.introspection-work/`, and its runtime;
2. the `Trivia Night bank` application, which signs the end-user token the bank verifies;
3. the `trivia-bank` MCP binding on the tunnel's `/mcp`, linked to that application. Each run points it at the new tunnel.

It writes `TRIVIA_ISSUER` (and `TRIVIA_AUDIENCE` when the binding has one) into `.env.local`, and never sets `TRIVIA_DEV_OWNER_HEADER`, so the bank verifies real tokens and refuses a call without one. Not logged in, the page runs alone and the bank refuses every call. `TRIVIA_NO_SETUP=1` serves the page, the bank and its tunnel without touching the project. `pnpm dev:app` runs the page alone, with no tunnel. The page's own `/bank/mcp` serves a separate bank for the local room scripts (`scripts/rooms.ts`, `scripts/host.ts`); the platform reaches only the tunnelled one.

```bash
pnpm test       # the bank, its MCP server, the scoring and the eval runner
```

## Run the evals from the page

The page runs the real memory evals, as [Run the memory evals](./recipe-operator/README.md#run-the-memory-evals) describes, against the `trivia-host` Runtime at its latest commit (or `INTROSPECTION_TRIVIA_RUNTIME_ID` and `INTROSPECTION_TRIVIA_COMMIT_SHA`, when both are set).

Each eval task and its verifier come from the Runtime's Recipe at that commit: `eval run` resolves `--path` inside that checkout, so the page tests with that commit's verifiers. To test a newer commit than the Runtime's latest version, set `INTROSPECTION_TRIVIA_COMMIT_SHA` and `INTROSPECTION_TRIVIA_RUNTIME_ID` in `.env.local`.

It needs a staging agent key that expires today, named in `.env.local`:

```bash
introspection api-keys create --environment staging --capabilities runtimes,evals \
  --expires-at <today, 23:59 UTC> --secret-file recipe-operator/.agent.key
echo TRIVIA_EVAL_KEY_FILE=recipe-operator/.agent.key >> .env.local
```

The runs use your `introspection login`, on `https://api.introspection.dev` unless `INTROSPECTION_API_BASE_URL` names another stack, and find the Data Plane from there. Without a key file the panel shows these commands and the server refuses to run.

Pick a number of venues and press **Run**. Venue _i_ plays the _i_-th venue profile (Sydney, Manchester, Chicago, and on across AU, UK and US pubs), all venues at once, each as its own customer:

| Trial                | Task             | Customer                                       | What it shows                                  |
| -------------------- | ---------------- | ---------------------------------------------- | ---------------------------------------------- |
| Night 1              | `night1-<venue>` | `anon:sim-<run>-<venue>`                       | the host learns the venue and writes its notes |
| Night 2, model notes | `night2-<venue>` | the same customer                              | it reads those notes                           |
| Night 2, no notes    | `night2-<venue>` | `anon:sim-<run>-<venue>-fresh`, a new customer | the same night with no notes                   |
| Night 2, other notes | `night2-<venue>` | another pub's night-1 customer                 | the same night with a different pub's notes    |
| Night 2, true notes  | `night2-<venue>` | a customer night 0 seeded with the true notes  | the same night with the crowd's real tastes    |

Every trial is tagged `simulation:<run>` and `simulation:trivia-night`. Trials are scored in their own sandbox, so seeing results needs neither tag; to browse the trials themselves, an admin already can, and an owner can give another member the `simulation:trivia-night` tag. The page reads as an experiment: the hypothesis that notes tune night 2 to the crowd, the method, and the result. The two night 2s at a pub differ only in the notes, so each pub is a paired comparison: the result is how far each round's share right was from 65%, with memory against without, as a mean of per-pub differences with a 95% t-interval (from 3 pubs; 11 pubs gives a meaningful result), with the other measures beside it. Each run starts new customers, so nothing carries over between runs; a run measures one version of the agent and changes nothing.

As a second opinion, the server grades each finished night 2 with the `return-visit` judge (`recipe-operator/judges/return-visit.yaml`): it converts the trial's local `trajectory.json` to the judge's conversation input and runs `introspection judges run --conversation <trial>/judge/input.jsonl`, scoring from 1 to 5 how tailored the night felt, with a one-line reason. It is one Sonnet judgement per night 2, about $0.01 to $0.03 each; the judge's model uses `ANTHROPIC_API_KEY` from the server's environment, or your Pi sign-in.

Each venue gets a card: what night 1 learned, and how each night 2 opened. Click a card for each trial's steps, read from its `trajectory.json` once the trial ends: each read of `memories/MEMORY.md` with its content (**read**, including the read the runtime makes before the first turn), each `trivia-bank` tool call with its arguments (**tool**), each write of the notes (**write**), and the agent's final message (**plan**), then its checks, reward and time. While a run is going the page shows its progress; a card fills in as its venue's trials finish.

The key reaches each `introspection eval run` only as `INTROSPECTION_TOKEN` in its environment: never in its arguments, the logs or the browser. The page is served only on this machine. Each trial's run folder is under `recipe-operator/eval-runs/<run>/`.

## What it costs

Every trial is a real model conversation, and the cost is mostly how many there are and how long each one runs.

| What                            | Volume                                               | Cost                                                   | Billed to                                               |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| **Run** with 3 venues           | 9 trials                                             | about $1                                               | your organization's platform usage                      |
| **Run** with 11 venues          | 33 trials                                            | about $3                                               | your organization's platform usage                      |
| One improve cycle, as first run | 178 four-night series nights plus 135 Operator turns | about $20 for the search, before held-out confirmation | the key or subscription the Operator and its trials use |

What the first improve cycle spent, measured from each trial's `trajectory.json` (`final_metrics`) and the Operator's Pi session:

- **Trials, $11.89:** 178 nights on Sonnet 5.5 at $0.067 each. A night is about 19 model turns (start the night, fetch, read out, mark, summarize, write notes), re-sending about 91 thousand input tokens, nine tenths cached, and writing 3.7 thousand. The volume is 5 designs, 3 venues, 4-night series and 2 repeats, plus the control's repeats to measure noise.
- **The Operator, $7.91:** 135 turns on Opus 5.5, each carrying about 92 thousand tokens of context (its skill references, scorecards and logs), billed to the API key because the key was in its environment.

To run an improve cycle for a few dollars instead:

1. Run the Operator on your Pi sign-in and give the API key only to the trials, not to the Operator's shell. The same search costs about 40% less.
2. Search smaller: 3 designs, 3-night series, one repeat, and the control's spread measured once. About 45 nights instead of 178.
3. Keep nights short: two short rounds bring a night from about 19 turns to about 8, roughly halving its cost.
4. Mount `~/.pi/agent/auth.json` into each trial's runtime container, so the trials use your Pi sign-in too.

With the first three, a full cycle on API keys is about $3 to $5.

## What is here

[ARCHITECTURE.md](./ARCHITECTURE.md) shows how the pieces fit, with diagrams of the system, a night, and how it is tested and improved.

| Piece                 | Where                                                                      | What it does                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Question bank         | [`lib/bank.ts`](./lib/bank.ts), [`lib/questions.ts`](./lib/questions.ts)   | 240 questions with a genre, region and difficulty (2,102 with `TRIVIA_BANK=large`). Tracks what each venue was asked and how its teams answered. Marks answers.          |
| MCP server            | [`lib/mcp.ts`](./lib/mcp.ts), served at `/mcp` by `scripts/bank-server.ts` | `start_night`, `register_teams`, `next_questions`, `submit_round`, `round_summary`, `scoreboard`. No tool takes a venue: the bank reads it from the caller's credential. |
| Scorer                | [`lib/scorer.ts`](./lib/scorer.ts)                                         | Tonight's teams, the season table, and a whole round's answer sheet marked in one call. Served by the same server as the bank.                                           |
| Identity              | [`lib/identity.ts`](./lib/identity.ts)                                     | Verifies the end-user token the platform sends, and refuses a call without one.                                                                                          |
| Simulated venues      | [`lib/venues.ts`](./lib/venues.ts)                                         | Crowds for the in-session room scripts, each a table of how well it knows each genre. Seeded, so a run repeats exactly.                                                  |
| Operator-built Recipe | [`recipe-operator/`](./recipe-operator)                                    | What a fresh Operator session built from [WALKTHROUGH.md](./WALKTHROUGH.md): the version to hill-climb on. Its bank is a contract it designed, not this one.             |
| The page              | [`components/platform-evals.tsx`](./components/platform-evals.tsx)         | A card per venue: what night 1 learned, how each night 2 opened, and each trial's steps and checks.                                                                      |
| Platform evals        | [`lib/platform-runner.ts`](./lib/platform-runner.ts), `/api/evals`         | Runs the memory evals as cloud trials, and puts each trial's result and its steps ([`lib/trial-steps.ts`](./lib/trial-steps.ts)) on the events feed.                     |

## Who owns what

The bank owns facts: which questions a venue has been asked, and who got them right. It cannot forget, and it grows without limit.

The host's memory owns judgement: the region, what the crowd likes, and the difficulty that suits it in each genre. That is small, and it gets rewritten.

So "never repeat a question" is the bank's job, and a host cannot get it wrong. "Pitch the night right" is the memory's job.

## How a night is scored

- **Pitch miss:** how far each round's share of right answers sat from 65%, on average. Lower is better.
- **Asked-for rounds:** rounds in a genre the venue said it likes.
- **Unfair questions:** questions local to somewhere else.
- **Repeats:** questions the venue had been asked before. The bank keeps this at zero.

## Who is asking

The bank is linked to an application, as [Tell a partner who the end user is](https://docs.introspection.dev/identity/applications#tell-a-partner-who-the-end-user-is) describes (`pnpm dev` does this), so each call carries a signed token naming the end user. The bank reads:

| Variable                    | Value                                                        |
| --------------------------- | ------------------------------------------------------------ |
| `TRIVIA_ISSUER`             | `https://<control plane>/v1/applications/<client-id>`        |
| `TRIVIA_AUDIENCE`           | The endpoint's audience, when it sets one                    |
| `TRIVIA_ACCEPT_ATTRIBUTION` | `1` to also accept a user that a backend named (`--subject`) |

It logs each tool call's owner (`[bank] tools/call as <sub>`) and each refusal with its reason (`[bank] refused tools/call: ...`).

With no platform, `TRIVIA_DEV_OWNER_HEADER=1` trusts an `x-trivia-owner` header instead. Never set it on a deployed bank; `pnpm dev` removes it.

## Reading the results

One venue on one night is noisy: a round is a few questions for a few teams, so a single trial can favour either side. Compare night 2 across venues, and against the control, not one row.

## What's next

What a run of `pnpm dev` on staging found, and is still open:

- **A member's own conversation gets no bank tools.** A chat started by a project member (the dashboard, or `introspection tasks create` with no `--subject`) lists no `trivia-bank` tools. The binding's check says: "This binding signs a per-task end-user identity, so its tools are listed only when a customer session runs."
- **A `--subject` conversation is refused by the bank.** With `introspection tasks create --subject <venue>` the agent calls `start_night` through the tunnel and the token verifies, but its `type` is `identity_attribution` (a user a backend named), which [`lib/identity.ts`](./lib/identity.ts) refuses by default: `[bank] refused tools/call: a identity_attribution token is not accepted`. An `identity_assertion` needs an end user signed in through the application, and this example has no sign-in. Undecided: accept attribution in dev (`TRIVIA_ACCEPT_ATTRIBUTION=1`), or add a sign-in so a real assertion flows.

Then:

1. The evidence: each simulated venue complains after a badly pitched night, as feedback on that conversation, so improve has failure modes to find.
2. The read and write memory cases, as Harbor tasks with this bank as the sidecar.
3. A larger bank: enough questions per genre, region and difficulty to hold the filter for a season.
4. The venues as customer members, once the bank accepts their tokens.
5. A judge for answers that are close but not a misspelling, calibrated on a labelled set before it marks anything.
6. `pnpm dev` pushing recipe/ changes to an existing `trivia-host` repository: today it seeds the repository only when it creates the runtime.
