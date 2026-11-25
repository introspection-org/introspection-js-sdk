# Trivia Night: a memory demo

A quiz host for pubs. The question bank never repeats a question at a venue, and a host that remembers the venue pitches each night to its crowd. The page runs the real memory evals on the platform and shows each night's rounds as its verifier scored them.

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

The eval runner's checks drive the real SDK against a recorded run of one pub (`tests/recordings/trivia-night-platform_*`), and the sign-in's code exchange against a recorded Control Plane (`trivia-night-login_*`). Re-record them against a local stack only, with `.env.local` naming the local planes, the Runtime, its commit and the sign-in client, and `TRIVIA_RECORD_TOKEN_FILE` naming a file holding a bearer token of that stack's project, which stands in for the member's own since the page's sign-in needs a browser: `pnpm test:platform:record` and `pnpm test:login:record`. The exchange is recorded for a code the platform never issued, since an issued one needs an interactive login; the session it keeps, and its expiry, are checked as unit tests. The recorded run drives the page's run functions through the Node client, whose calls match the browser client's but for the bearer token in place of the cookie.

## Run the evals from the page

The page runs the real memory evals, as [Run the memory evals](./recipe-operator/README.md#run-the-memory-evals) describes, against the configured trivia Runtime at the configured commit (see [Sign in](#sign-in)).

Each trial is a plain platform call through the SDK, with no CLI: the server reads the Harbor task (`instruction.md`, `task.toml`, `tests/`, `environment/docker-compose.yaml`) from the Runtime's repository at that commit through the repository contents API, packs `tests/` as the task's own `verifier`, and creates a `kind: eval` task with the commit, the customer's identity, the run's tags and the compose. Once the run settles the page completes the task (`PATCH status: completed`); the platform runs the verifier in the trial's sandbox while the task is `finishing`, records the outcome as `metadata.verification`, and only then marks it `completed`. The page reads the outcome's result and log files. To test another commit, set `NEXT_PUBLIC_INTROSPECTION_TRIVIA_COMMIT_SHA` in `.env.local`.

Nothing about a run is kept on the server: a run is its tasks. Start creates each pub's first nights and returns; each poll of the run lists its tasks by the `simulation:<run>` tag, completes a trial whose run has settled so it is scored, and creates a night 2 once the night it waits on is `completed` with a verification that reports no error (otherwise it is skipped). Every trial task carries the run's settings in its metadata (`trivia_night`), which is all a poll needs to know which nights are still to come, so any instance of the page can serve any poll. Two polls that both create a night make one trial between them: each trial carries its step's `admission_key` (a uuid5 of the run and the step), the platform admits one task per key under a lock and answers a second create with `409`, and the page then reads the existing task. A tab never overlaps its own polls.

The trials' sidecar, the trivia bank fake, runs an image the page finds by its folder's git tree at that commit; the contents API returns no file over 1 MB whole, so the page cannot build it. `pnpm dev` builds it after each push, or run `pnpm sidecar:image`, which checks every file against the commit first.

### Sign in

The page is client-side: it signs a member in in the browser and every trial runs as them, so its usage is billed to their organization. Opening it without a session sends you to the platform's hosted login (`/v1/oauth/authorize` on `NEXT_PUBLIC_INTROSPECTION_API_BASE_URL`), where you pick the project the trials run in, and back to `/callback`, which exchanges the code (PKCE) at the Control Plane's token endpoint. The token waits in sessionStorage until it expires, when the page signs in again; it is redeemed once at the Data Plane's `/v1/oauth/exchange`, and every platform call then rides the Data Plane's session cookie through the browser SDK (`@introspection-sdk/introspection-browser/api`). Each trial records the member's id as `started_by`.

The browser reaches only the Data Plane, so it cannot look a Runtime up: the page runs the Runtime its configuration names, once its commit is seen to hold the generated venue tasks. A Runtime made from the manifest alone has none, since git ignores them, so the panel asks for them to be pushed with the recipe, as `pnpm dev` does. Register the page once as a `spa` application whose ceiling holds every scope a run calls, with `introspection login --url <Control Plane>` first for anything but production:

```bash
introspection applications create --type spa --name "Trivia night" \
  --redirect-uri http://localhost:3500/callback --allowed-origin http://localhost:3500 \
  --allowed-scope "tasks:read tasks:write tasks:eval tasks:exec files:read files:write repositories:read images:read"
echo NEXT_PUBLIC_TRIVIA_SPA_CLIENT_ID=<the printed client_id> >> .env.local
```

The Data Plane must allow the page's origin for CORS (`CORS_ORIGINS` on the Data Plane). The platform grants a member only the scopes their role holds, and an eval task needs `tasks:eval` and `tasks:exec`, so only an organization owner or admin can start or move a run on; another member reads the runs and the panel says why the **Run** button is off.

| Variable                                         | Default                         | What it is                                                                   |
| ------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------- |
| `NEXT_PUBLIC_TRIVIA_SPA_CLIENT_ID`               | none                            | The `spa` application's `client_id`.                                         |
| `NEXT_PUBLIC_INTROSPECTION_API_BASE_URL`         | `https://api.introspection.dev` | The Control Plane, for the login. A local stack is `http://localhost:8000`.  |
| `NEXT_PUBLIC_INTROSPECTION_DP_URL`               | the Control Plane's URL         | The Data Plane the trials run on. A local stack is `http://localhost:8002`.  |
| `NEXT_PUBLIC_INTROSPECTION_TRIVIA_RUNTIME_ID`    | none                            | The trivia Runtime to run; without it and the two below the page cannot run. |
| `NEXT_PUBLIC_INTROSPECTION_TRIVIA_REPOSITORY_ID` | none                            | The repository holding its Recipe.                                           |
| `NEXT_PUBLIC_INTROSPECTION_TRIVIA_COMMIT_SHA`    | none                            | The commit to run, which must hold the generated venue tasks.                |
| `NEXT_PUBLIC_INTROSPECTION_TRIVIA_RECIPE_PATH`   | the repository's root           | The Recipe's folder in that repository.                                      |

**Memory is off for these trials for now.** The platform gives an eval task memory only when an agent's credentials run it, and a member's own eval tasks own none yet, so every night 2 runs without notes, whatever its arm. The panel says so instead of reading the arms' sameness as "no memory effect"; a run measures memory again once the platform lets a member's eval tasks own memory.

Pick a number of venues and press **Run**. Venue _i_ plays the _i_-th venue profile (Sydney, Manchester, Chicago, and on across AU, UK and US pubs), all venues at once, each as its own customer:

| Trial                | Task             | Customer                                       | What it shows                                  |
| -------------------- | ---------------- | ---------------------------------------------- | ---------------------------------------------- |
| Night 1              | `night1-<venue>` | `anon:sim-<run>-<venue>`                       | the host learns the venue and writes its notes |
| Night 2, model notes | `night2-<venue>` | the same customer                              | it reads those notes                           |
| Night 2, no notes    | `night2-<venue>` | `anon:sim-<run>-<venue>-fresh`, a new customer | the same night with no notes                   |
| Night 1, another pub | `night1-<other>` | `anon:sim-<run>-<venue>-wrong`, a new customer | another pub's night, writing its notes         |
| Night 2, other notes | `night2-<venue>` | that same customer                             | the same night with a different pub's notes    |
| Night 2, true notes  | `night2-<venue>` | a customer night 0 seeded with the true notes  | the same night with the crowd's real tastes    |

Every trial is tagged `simulation:<run>` and `simulation:trivia-night`. Trials are scored in their own sandbox, so seeing results needs neither tag; to browse the trials themselves, an admin already can, and an owner can give another member the `simulation:trivia-night` tag. The page reads as an experiment: the hypothesis that notes tune night 2 to the crowd, the method, and the result. The two night 2s at a pub differ only in the notes, so each pub is a paired comparison: the result is how far each round's share right was from 65%, with memory against without, as a mean of per-pub differences with a 95% t-interval (from 3 pubs; 11 pubs gives a meaningful result), with the other measures beside it. Each run starts new customers, so nothing carries over between runs; a run measures one version of the agent and changes nothing.

Each venue gets a card with a tab per night: what night 1 learned, whose notes the other-notes night had, and each round's questions and team marks, all from the verifier's output. The **Questions | Under the hood** switch changes only that night detail, never the charts: under the hood shows the host's steps in order (its memory read, each bank call, its notes written and its closing message) and what the verifier measured. A trial's conversation is not the page's to read; the verifier reads the GenAI spans the runtime keeps in the sandbox instead and writes a bounded step list, with credentials redacted, into its result file (`/logs/verifier/result.json`; `reward.json` beside it keeps only the numbers Harbor reads). While a run is going the page shows its progress; a card fills in as its venue's trials finish. [`experiment/analyze.mts`](./experiment/README.md) prints a run's pre-registered analysis from the same tasks.

## Add it to your own project

The recipe in `recipe-operator/` is published with a Runtime manifest, [`.introspection/trivia-night.yaml`](../../.introspection/trivia-night.yaml). From a clone of this repository, signed in with `introspection login`:

```bash
introspection runtimes create --manifest .introspection/trivia-night.yaml
```

The host plays only through the `trivia-bank` MCP server, which `pnpm dev` serves and binds; the page's evals also need the Harbor tasks `pnpm evals:venues` generates (git ignores them, so `pnpm dev` pushes them with a copy of the recipe) and the bank's sidecar image (`pnpm sidecar:image`).

## Deploy

`.github/workflows/deploy-trivia-night.yml` deploys the page to Vercel: a push to `main` makes a preview aliased to `trivia-night.staging.introspection.dev`, and a manual run with `production` deploys production. The repository's `build` environment needs the variables `VERCEL_ORG_ID` and `VERCEL_TRIVIA_PROJECT_ID` and the secret `VERCEL_API_TOKEN`; the Vercel project needs `NEXT_PUBLIC_INTROSPECTION_API_BASE_URL`, `NEXT_PUBLIC_INTROSPECTION_DP_URL`, `NEXT_PUBLIC_TRIVIA_SPA_CLIENT_ID`, `NEXT_PUBLIC_INTROSPECTION_TRIVIA_RUNTIME_ID`, `NEXT_PUBLIC_INTROSPECTION_TRIVIA_REPOSITORY_ID` and `NEXT_PUBLIC_INTROSPECTION_TRIVIA_COMMIT_SHA`, `NEXT_PUBLIC_INTROSPECTION_TRIVIA_PROJECT` (the project's slug or id, `trivia` by default, so sign-in goes straight to it), and `NEXT_PUBLIC_INTROSPECTION_TRIVIA_RECIPE_PATH` when the Recipe is not at its repository's root. They are public: the page holds no secret, and trials run as the signed-in member. The `spa` application's ceiling must allow `tasks:read tasks:write tasks:eval tasks:exec files:read files:write repositories:read images:read`, its redirect URIs must include the deployed `/callback`, and the Data Plane must allow the deployed origin for CORS.

## What it costs

Every trial is a real model conversation, and the cost is mostly how many there are and how long each one runs.

| What                            | Volume                                               | Cost                                                   | Billed to                                               |
| ------------------------------- | ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| **Run** with 3 venues           | 21 trials                                            | about $2                                               | your organization's platform usage                      |
| **Run** with 11 venues          | 77 trials                                            | about $7                                               | your organization's platform usage                      |
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

| Piece                 | Where                                                                                                      | What it does                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Question bank         | [`lib/bank.ts`](./lib/bank.ts), [`lib/questions.ts`](./lib/questions.ts)                                   | 240 questions with a genre, region and difficulty (2,102 with `TRIVIA_BANK=large`). Tracks what each venue was asked and how its teams answered. Marks answers.              |
| MCP server            | [`lib/mcp.ts`](./lib/mcp.ts), served at `/mcp` by `scripts/bank-server.ts`                                 | `start_night`, `register_teams`, `next_questions`, `submit_round`, `round_summary`, `scoreboard`. No tool takes a venue: the bank reads it from the caller's credential.     |
| Scorer                | [`lib/scorer.ts`](./lib/scorer.ts)                                                                         | Tonight's teams, the season table, and a whole round's answer sheet marked in one call. Served by the same server as the bank.                                               |
| Identity              | [`lib/identity.ts`](./lib/identity.ts)                                                                     | Verifies the end-user token the platform sends, and refuses a call without one.                                                                                              |
| Simulated venues      | [`lib/venues.ts`](./lib/venues.ts)                                                                         | Crowds for the in-session room scripts, each a table of how well it knows each genre. Seeded, so a run repeats exactly.                                                      |
| Operator-built Recipe | [`recipe-operator/`](./recipe-operator)                                                                    | What a fresh Operator session built from [WALKTHROUGH.md](./WALKTHROUGH.md): the version to hill-climb on. Its bank is a contract it designed, not this one.                 |
| The page              | [`components/platform-evals.tsx`](./components/platform-evals.tsx)                                         | A card per venue: what night 1 learned and each night's rounds.                                                                                                              |
| Platform evals        | [`lib/platform-runner.ts`](./lib/platform-runner.ts), [`lib/browser-session.ts`](./lib/browser-session.ts) | Runs the memory evals from the browser as `kind: eval` tasks that verify themselves, through the browser SDK: the sign-in, starting a run, moving it on and reading results. |

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
