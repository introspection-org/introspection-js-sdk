# Flight Sector: a Personal Agent Protocol travel demo

Sam's flight QF74 to Sydney is delayed six hours. Sam asks Atlas, his own Personal Agent, to get him there in time. Atlas finds Flight Sector over the [Personal Agent Protocol](https://personalagentprotocol.org/docs/0.3/spec) (Poppy, draft 0.3), has Sam sign in once, and talks with Flight Sector's agent: the real [travel-agent recipe](https://github.com/introspection-recipes/recipe-travel-agent) on Introspection. Behind it, nothing changes from [`aauth-travel`](../aauth-travel): the agent books over AAuth, so Acme's Person Server speaks for Sam, and Dana approves the trip's budget and anything over it. **Poppy in front, AAuth behind.**

The page is the one `aauth-travel` shows, from [`travel-demo-ui`](../travel-demo-ui): Sam's phone (here, Atlas), what happens behind the chat at each turn, and every request on the wire, with Atlas's `Poppy-Session` header decoded. The world behind it, the booking provider, Acme's Person Server, the Browserbase mock, the run on Introspection and `pnpm dev`, is [`travel-demo-flow`](../travel-demo-flow), shared with `aauth-travel`.

## The flow

| Sam                             | What happens on the wire                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "My QF74 to Sydney is delayed…" | Atlas fetches Flight Sector's `/.well-known/poppy.json` (version `0.3`, its `organization.domain` the host that served it), finds the issuer from `/.well-known/oauth-protected-resource`, and checks that the issuer lists `https://{domain}` in `protected_resources`. The conversation entry says `access: signed_in`: Flight Sector's agent acts on an account, so Atlas has Sam sign in before it says anything.                                                                                                                                                                                                       |
| Signs in at Flight Sector       | **Direct Sign-In**, plain OAuth: the authorization code grant with PKCE on Flight Sector's page, where Sam allows `bookings:read` and `bookings:write`. Atlas's client assertion is addressed to the issuer; it gets an ordinary refresh token and access token. The token endpoint never sees a Session.                                                                                                                                                                                                                                                                                                                   |
| —                               | Atlas opens a **conversation** with what Sam asked and the booking he holds. Every request carries a `Poppy-Session` JWT signed for that request by a delegated key (`poppy_dlg`), and the access token, which its `ath` covers. Flight Sector maps the signed-in account to Sam's member on Introspection (never anyone Atlas names) and starts a task on the travel runtime, as the recipe's `poppy` agent. The agent searches, quotes, and offers UA863 (no more than Sam paid) or QF8 via Dallas ($400 more). Its replies, read from the run, become `message` events; the task's state is the conversation's `status`. |
| "The one at no extra cost"      | Atlas passes Sam's words on as his (`author.type: human`). The agent proposes the trip: **Dana approves it** at Acme, behind the chat, and the flight books.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| "QF8 via Dallas"                | The agent calls `request_approval` with the exact terms. Flight Sector sends them to Atlas as an **Operations v2** operation (`operation_id`, `revision`, `expires_at`), and Atlas shows **Sam** the terms in his phone.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Approves                        | Atlas sends `extensions.operations.approval`. Flight Sector checks the revision is one this conversation returned, still current, and not acted on, and tells the agent once; a retry adds nothing. The agent proposes the trip and books: **Dana** approves the budget at Acme, and again if the fare is over what is left.                                                                                                                                                                                                                                                                                                |
| Disconnect                      | Atlas closes the conversation and revokes the refresh token. The Session carries on signed out: reading the conversation gets a `401` challenge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Two approvals, by two people, each on their own device: Sam approves Flight Sector's terms in Atlas, and Dana approves the spend for Acme in her inbox.

## Run it

You need Node 24, pnpm, [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`brew install cloudflared`), the [portless](https://github.com/vercel-labs/portless) proxy on port 443 (`sudo npx portless proxy start` once), and an Introspection account.

```bash
pnpm add -g @introspection-ai/cli   # after `pnpm setup` once, if pnpm has no global directory yet
introspection login                  # your organization and project
pnpm install
RECIPE_REF=claude/zen-hopper-k1e7z2 pnpm --filter introspection-example-pap-travel dev
```

Then open `https://atlas.localhost` and send a sample prompt as Sam.

`pnpm dev` is `aauth-travel`'s ([`travel-demo-flow/dev.sh`](../travel-demo-flow/dev.sh)), on port 3500: it serves the app, gives the booking provider and the Browserbase mock public https URLs, and sets your project up the first time (the hosted repository seeded from the recipe, its runtime, flight search, the booking connector, Sam as a customer member, and the application secrets in `.env.local`). Atlas and Flight Sector's Poppy host are on portless, since only this machine calls them.

**The recipe version.** The Poppy agent, `agents/poppy.yaml` with its `request_approval` tool, is on the recipe's `claude/zen-hopper-k1e7z2` branch until it is merged. `RECIPE_REF` puts the recipe at that ref in your hosted repository and builds the runtime again; without it the repository keeps what it was seeded with, the recipe's default branch, and tasks for the `poppy` agent fail. Once the recipe change is on its main branch, leave `RECIPE_REF` unset.

### Public URLs

As in `aauth-travel`: quick tunnels by default, new each run, or a named tunnel on your own domain with `FLIGHTSECTOR_DOMAIN=example.dev`. See [its README](../aauth-travel/README.md#public-urls).

### Options

- `PERSON_SERVER=acme` has Acme run its own Person Server here instead of Introspection's hosted one.
- `BROWSERBASE_API_KEY=…` searches real flights through Browserbase's hosted MCP instead of the mock.
- `RECIPE_URL` and `RECIPE_REF` choose the recipe and its ref.
- `ATLAS_URL` and `COMPANY_URL` move Atlas and Flight Sector's Poppy host to other https origins.

The conversation bar opens the Introspection conversation behind the current Poppy conversation: Flight Sector's own view of the task its agent runs.

## Without Introspection

`pnpm e2e` checks the Poppy protocol between Atlas and Flight Sector's endpoints with no backend. It is a protocol test, not the demo: the Company Agent is a stub at the bridge boundary ([`lib/company/stub-agent.ts`](./lib/company/stub-agent.ts), `POPPY_AGENT=stub`) that answers with fixed lines and one `request_approval`, so no model, recipe, mission or Acme runs. It starts the app itself, with Atlas and Flight Sector on portless.

`pnpm test` runs the bridge against a fake task: how messages become turns and replies become events, the member Flight Sector acts for, and operations acted on once.

## What is real

The protocol is real: discovery and its domain and issuer checks; agent identity by Client ID Metadata Document with `private_key_jwt`; Session JWTs signed per request by a delegated key and verified with their delegation, `aud`, `htm`/`htu`, `iat` window, replay cache and `ath`; the authorization code flow with PKCE and `iss`; company-defined scopes with descriptions and hints; conversation ownership, retry-safe message IDs, cursors, `wait` and close; operations with signed revisions, expiry and at-most-once; and revocation. Flight Sector's agent is the recipe on Introspection, and everything behind it is `aauth-travel`'s.

Atlas is scripted: it relays Sam's words and Flight Sector's replies, and its own lines are fixed. Flight Sector keeps its Poppy and OAuth state in memory, Sam is already signed in to Flight Sector's site, and one Poppy conversation runs at a time, since the page follows one task.

## When it doesn't work

- **The agent never answers, or the task fails at once:** the runtime has no `poppy` agent. Run `pnpm dev` with `RECIPE_REF` (above).
- **`https://atlas.localhost` does not load:** the portless proxy is not on port 443; start it with `sudo npx portless proxy start`.
- Everything else is as in [`aauth-travel`](../aauth-travel/README.md#when-it-doesnt-work).

## Compared with `aauth-travel`

|                                      | `pap-travel`                                                                | `aauth-travel`                           |
| ------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------- |
| Who talks to Flight Sector's agent   | Sam's own Personal Agent, Atlas, over Poppy                                 | Sam, in Flight Sector's own chat         |
| Who vouches for Sam to Flight Sector | Sam signs in to his Flight Sector account                                   | Acme's Person Server                     |
| Who the agent acts for               | The member Flight Sector holds for that account                             | Sam's member                             |
| The $400 option                      | Sam approves the exact terms (Operations v2), then Dana approves the budget | Dana, against what is left of the budget |
| Each request to Flight Sector        | A `Poppy-Session` JWT for its method and URL, covering the access token     | —                                        |
| Each request behind it               | An RFC 9421 signature, by Introspection's egress                            | The same                                 |
