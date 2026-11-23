# Trivia Night: a memory demo

A quiz host for pubs. The question bank never repeats a question at a venue, and a host that remembers the venue pitches each night to its crowd. The page shows every bank lookup and every memory read and write as it happens.

> **Status:** the bank, its MCP server, the simulated venues and the page run with no platform. `pnpm dev` also deploys the Recipe as the `trivia-host` Runtime and binds the bank to it on a public URL, and the agent calls the bank, but the bank does not yet accept the token the platform sends for it; [What's next](#whats-next) says why and what is missing.

## The point: improve

The sample exists to show one thing: the host starts with no memory, and the Operator's improve step changes the Recipe so it keeps and uses notes on each venue.

| Stage                         | What exists                                                                              | State                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------- |
| The agent to improve          | [`recipe/`](./recipe): a host that pitches every night at difficulty 3 and keeps nothing | Passes `introspection check`; `pnpm dev` deploys it |
| Evidence improve reads        | Each night's conversation, the venue's complaint afterwards, and the bank's results      | Not built                                           |
| What improve may change       | The `## Memory` block in `recipe/SYSTEM.md`, a notes file, a skill for pitching a night  | Not built                                           |
| Proof the change worked       | The simulated venues, scored as below                                                    | Scoring built; not wired to an agent                |
| What a good result looks like | The `attentive` stand-in host                                                            | Built: it bounds how much improve can gain          |

Improve works on single conversations today, and memory spans several. So each memory case is one conversation with the venue's notes already in place: a **read** case checks that tonight's plan follows the notes, and a **write** case checks that the notes exist after a night.

## Run it

You need Node 22 or later, pnpm, and cloudflared (`brew install cloudflared`).

```bash
pnpm install
```

```bash
pnpm dev
```

It serves the page and the bank on `http://localhost:3500` and the bank on a free Cloudflare quick tunnel, new each run. On whichever stack `introspection login` chose (staging, production or your own) it then sets up, and on a later run only checks:

1. the `trivia-host` Runtime: a repository Introspection hosts, seeded from a copy of [`recipe/`](./recipe) in `.introspection-work/`, and its runtime;
2. the `Trivia Night bank` application, which signs the end-user token the bank verifies;
3. the `trivia-bank` MCP binding on the tunnel's `/bank/mcp`, linked to that application. Each run points it at the new tunnel.

It writes `TRIVIA_ISSUER` (and `TRIVIA_AUDIENCE` when the binding has one) into `.env.local`, and never sets `TRIVIA_DEV_OWNER_HEADER`, so the bank verifies real tokens and refuses a call without one. Not logged in, the page runs alone and the bank refuses every call. `TRIVIA_NO_SETUP=1` serves the app and its tunnel without touching the project. `pnpm dev:app` runs the page alone, with no tunnel.

Open `http://localhost:3500`, pick a venue and play a few weeks with each host.

```bash
pnpm test       # the bank, its MCP server and the scoring
```

```bash
pnpm simulate   # every venue, both hosts, as a table
```

## What is here

| Piece              | Where                                                                    | What it does                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Question bank      | [`lib/bank.ts`](./lib/bank.ts), [`lib/questions.ts`](./lib/questions.ts) | 72 questions with a genre, region and difficulty. Tracks what each venue was asked and how its teams answered. Marks answers.                                            |
| MCP server         | [`lib/mcp.ts`](./lib/mcp.ts), served at `/bank/mcp`                      | `start_night`, `register_teams`, `next_questions`, `submit_round`, `round_summary`, `scoreboard`. No tool takes a venue: the bank reads it from the caller's credential. |
| Scorer             | [`lib/scorer.ts`](./lib/scorer.ts)                                       | Tonight's teams, the season table, and a whole round's answer sheet marked in one call. Served by the same server as the bank.                                           |
| Identity           | [`lib/identity.ts`](./lib/identity.ts)                                   | Verifies the end-user token the platform sends, and refuses a call without one.                                                                                          |
| Simulated venues   | [`lib/venues.ts`](./lib/venues.ts)                                       | Five crowds, each a table of how well it knows each genre. Seeded, so a run repeats exactly. Two are held out.                                                           |
| Two stand-in hosts | [`lib/host.ts`](./lib/host.ts)                                           | `forgetful` plans every night the same way. `attentive` keeps notes per venue and is the reference answer.                                                               |
| The page           | [`components/trivia-demo.tsx`](./components/trivia-demo.tsx)             | Both hosts side by side, the attentive host's notes, and the event log.                                                                                                  |

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

## What the simulation found

- The reference host pitches better the night after it learns: over 20 seeds its week-2 pitch miss is at least a fifth lower than the forgetful host's, and it serves no unfair questions.
- **The bank is too small.** By week 3 a venue's liked genres run dry, the difficulty filter is relaxed away, and the reference host is no better than the forgetful one. 72 questions is a seed, not a bank.
- **One venue on one night is noisy.** A round is 3 questions for 4 to 8 teams, so a single night can favour either host. Compare across venues and weeks, not one row.

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
