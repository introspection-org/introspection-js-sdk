# Flight Sector: an AAuth travel demo

Flight Sector books work travel for other companies' employees. An employee messages Flight Sector's travel agent, and the agent proposes the trip to **that employee's company**. The traveller's manager approves the trip once, with its budget; bookings within it then need no one, and one over what is left goes back to the manager. Once they decide, the conversation picks up by itself.

None of this is decided by the model, and the agent never holds a credential. It runs on [AAuth](https://github.com/dickhardt/AAuth) at -11, three-party, with a mission:

- the **Agent Provider** (the platform's control plane) mints an agent token for each session, binding the session's Ed25519 key;
- the platform's **egress** signs each of the agent's requests (RFC 9421) and presents the best token it holds;
- the traveller's **Person Server** (Acme's) approves the trip as a **mission** and issues person tokens under it;
- the **resource** (Flight Sector's booking provider) answers `401` with a resource token naming one booking's R3 proposal;
- egress takes the resource token to Acme, which answers `200` with an auth token within the trip's budget, `202` while it asks the manager, or `403`.

This example is the **Flight Sector side and the Acme side** of the demo, and the explainer. The platform side (Agent Provider, egress signing, missions, waiting on a `202`) lives in `introspection-cloud`; see `docs/design/connectors-aauth-b2b2c.md` §12.

- **Booking provider** (`https://booking.flightsector.localhost`) is a native three-party AAuth resource on [`@aauth/resource`](https://www.npmjs.com/package/@aauth/resource). Search is open and every offer carries a quote it signs. A reservation presenting an agent token gets `401 requirement=person-token`; one presenting a person token gets `401 requirement=auth-token` and a resource token for an R3 proposal only the person's Person Server can read; one presenting an auth token for that proposal is booked.
- **Acme's Person Server** is Acme's system, not Flight Sector's, and it runs one of two ways (`PERSON_SERVER`):
  - `hosted`: Introspection's hosted Person Server (`https://ps.introspection.localhost`, introspection-cloud `connectors-aauth-b2b2c.md` §11) runs the protocol, the missions and their budgets, with Acme as its own tenant. Acme keeps the human side: its approval app (`lib/acme/hosted.ts`) lists what is waiting at `/v1/approvals` with its project's key, emails the approver a code, and records the answer.
  - `acme`: Acme runs its own (`https://ps.acme.localhost`, `lib/acme/person-server.ts`), as a Business that brings its own Person Server would.

  Either way the trip's manager approves it, budget and all, by a six-digit emailed code (page at `/approve/{id}`). Within the trip, an auth token is issued for each booking whose price (the resource token's `budget`) fits what is left, and anything over goes back to the manager. Nothing books outside a mission.

- **The walkthrough** (`https://flightsector.localhost`) covers every step of the flow, beside the code behind it. Steps light up as these services see traffic. `WALKTHROUGH.md` is the same thing as a document.

The agent itself is the public [travel-agent recipe](https://github.com/introspection-org/recipe-travel-agent). The walkthrough reads it from GitHub at the commit pinned in `flow/recipe.mjs`; while that repository is private, set `GITHUB_TOKEN` for the page to show its code.

## The flow

Sam's trip is "Flights and a hotel for Sam, 19 to 23 October, up to $3,000."

| Sam asks for                      | What happens                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| The trip                          | `202`: Acme emails Dana, Sam's manager, a code. Dana approves the mission on Acme's page        |
| QF74 economy, SFO to SYD ($1,650) | `200`: within the trip's budget, so Acme issues an auth token and it's booked with no one asked |
| QT Sydney, 4 nights ($1,680)      | `202`: $1,350 is left, so Acme asks Dana again. Dana approves, and it's booked                  |
| A booking with no trip            | `403` from Acme, and from the recipe's `missionless-booking` rule before that                   |
| "That's everything"               | the agent proposes the mission complete; Sam accepts, and nothing more books under it           |

One booking, end to end. The agent is the travel-agent recipe running on Introspection; every arrow from it is a request Introspection's egress signs with the session's key (RFC 9421), after Flight Sector's rails allow it.

```mermaid
sequenceDiagram
    autonumber
    participant Sam
    participant Agent as Flight Sector's agent (on Introspection)
    participant Rails as Flight Sector's rails (Cedar, in the egress)
    participant Booking as Booking provider
    participant Acme as Acme's Person Server
    participant Dana as Dana (Sam's manager)

    Sam->>Agent: Sydney, 19 to 23 Oct, economy and the QT, up to $3,000
    Agent->>Acme: POST /ps/mission (the trip, login_hint Sam)
    Acme-->>Agent: 202 + Location (pending)
    Acme->>Dana: email with a six-digit code
    Dana->>Acme: approve, budget $3,000
    Agent->>Acme: GET /ps/pending/{id}
    Acme-->>Agent: 200 mission (s256) + person token

    Agent->>Rails: booking.reserve (cabin, payer, purpose, total from the signed quote)
    alt a forbid matches (first class, personal on the company, no mission)
        Rails-->>Agent: deny, with the rule's reason
    else permitted
        Rails-->>Agent: allow
        Agent->>Booking: POST /v1/reserve with the person token
        Booking-->>Agent: 401 requirement=auth-token + resource token (R3 proposal)
        Agent->>Acme: POST /ps/token with the resource token, mission s256
        Acme->>Booking: GET /r3/{id} (signed): what exactly is being booked
        alt within what's left of the budget
            Acme-->>Agent: 200 auth token
        else over budget
            Acme-->>Agent: 202 + Location
            Acme->>Dana: email: approve this booking?
            Dana->>Acme: approve or decline
            Agent->>Acme: GET /ps/pending/{id}
            Acme-->>Agent: 200 auth token, or 403 declined
        end
        Agent->>Booking: POST /v1/reserve with the auth token (same parameters)
        Booking-->>Agent: 200 booked
    end

    Agent->>Acme: POST /ps/mission/{s256} completion
    Acme->>Sam: email: is the trip done?
    Sam->>Acme: accept
    Acme-->>Agent: 200: mission completed, nothing more books under it
```

| Token          | What it says                                                                |
| -------------- | --------------------------------------------------------------------------- |
| agent token    | who the agent is: the Agent Provider binds the session's key                |
| mission        | the trip the manager approved, and its budget, by hash (`mission_s256`)     |
| person token   | the person the agent acts for, at one resource, under the mission           |
| resource token | the booking provider's ask: one reservation's R3 proposal, readable by Acme |
| auth token     | Acme's grant for exactly that reservation; the provider checks the retry    |

## Run it

Every party is its own AAuth server, and an AAuth server identifier is `https://host` with no port or path. One Next.js process serves all of them under three hostnames, which [portless](https://github.com/vercel-labs/portless) gives trusted https names on `:443`; `next.config.ts` routes each host to its part of the app.

```bash
pnpm install
pnpm --filter introspection-example-aauth-travel dev   # https://flightsector.localhost
```

Without `RESEND_API_KEY`, Dana's email, with its code, is printed to this app's console.

### The demo page, on Introspection

`https://flightsector.localhost/demo` is the demo. Sam types a request (or picks a sample prompt), and the page starts a real task on the `travel-agent` runtime, the [travel-agent recipe](https://github.com/introspection-org/recipe-travel-agent), acting for Sam: it opens a runner with the identity `user_id: sam@acme.example`, which mints Sam's customer member, so Introspection's control plane issues the agent token and its egress signs every call the agent makes, after running Flight Sector's Cedar rails. Three panes show the chat from the task's AG-UI stream, what the agent's tools, Acme and the booking provider each saw, and every request as it arrived here, signed by the egress. When Acme needs Dana or Sam, the email appears on the page; once it's answered, the platform resumes the task by itself and the page follows the new run.

Run it against the local stack in `introspection-cloud`:

```bash
make dev-aauth-demo        # AAuth agent and policy gate on in the local egress
make seed-applications seed-travel-agent
make seed-aauth-demo       # booking connector, the browserbase MCP, Sam, and this app's .env.local
```

`seed-aauth-demo` binds the `browserbase` MCP (the mock here, or Browserbase's hosted MCP when `BROWSERBASE_API_KEY` is set), and writes `INTROSPECTION_BASE_API_URL`, `INTROSPECTION_RUNTIME` and `DEMO_SAM_USER_ID` here, and `INTROSPECTION_TOKEN` when it can mint a project API key; otherwise add one by hand. Acme's Person Server knows Sam as `user:sam@acme.example`, the key the platform gives a runner identity.

To exercise the whole flow without the platform, play the agent with the e2e script. It uses [`@aauth/agent`](https://www.npmjs.com/package/@aauth/agent) as the egress would, and runs a test Agent Provider at `https://e2e-agents.localhost`, which the dev server must trust:

```bash
TRUSTED_AGENT_PROVIDERS=https://cp.introspection.localhost,https://e2e-agents.localhost \
  pnpm dev > /tmp/aauth-travel.log 2>&1 &
portless alias e2e-agents 3499 --force
E2E_SERVER_LOG=/tmp/aauth-travel.log NODE_EXTRA_CA_CERTS=~/.portless/ca.pem node scripts/e2e-aauth.mjs
```

Every server here fetches the others' metadata, so Node must trust portless's CA: `pnpm dev` points `NODE_EXTRA_CA_CERTS` at `~/.portless/ca.pem` unless it is already set.

### With the platform

In `introspection-cloud`, `make dev-aauth-demo` turns the AAuth agent and the policy gate on in the local egress and points them at this app. The control plane is the Agent Provider at `https://cp.introspection.localhost` (`portless alias cp.introspection 8000`). Portless listens on loopback only, so the containers reach this app on `:3400` directly, still signing for its https hosts. Then create the booking connector:

| Setting           | Value                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Booking connector | slug `booking`, `auth_mode: aauth`, `person_server_url: https://ps.acme.localhost`, `api_hosts: [api.booking.example]`, `metadata: {"aauth_resource": "https://booking.flightsector.localhost", "aauth_upstream": "https://booking.flightsector.localhost"}`                                                                                                                    |
| Booking provider  | `https://booking.flightsector.localhost` (no credential: egress signs, the provider verifies)                                                                                                                                                                                                                                                                                   |
| Flight search     | an `mcp` endpoint with `mcp_server_id: browserbase`: this app's mock at `https://browserbase.flightsector.localhost/mcp` (any bearer; it answers like Browserbase's hosted MCP for the recorded SFO⇄SYD searches, and lists the booking provider's flights for other routes), or the real `https://mcp.browserbase.com/mcp` with `Authorization: Bearer ${BROWSERBASE_API_KEY}` |

The recipe's `policies/` (Flight Sector's rails) run in the egress before anything is signed, with the session's approved mission as `context.mission`. The seniority rule reads two things an org owner sets:

- each traveller's level and company, as member `policy_attributes`:

  ```bash
  curl -X PATCH "$CP/v1/members/$SAM_MEMBER_ID" -H "Authorization: Bearer $OWNER_TOKEN" \
    -d '{"policy_attributes": {"level": 5, "company": {"__entity": {"type": "Company", "id": "acme"}}}}'
  ```

- each company's threshold, as the booking connector's `policy_entities`:

  ```bash
  curl -X PATCH "$CP/v1/connectors/$BOOKING_CONNECTOR_ID" -H "Authorization: Bearer $OWNER_TOKEN" \
    -d '{"policy_entities": [
          {"uid": {"type": "Company", "id": "acme"},   "attrs": {"business_min_level": 5}, "parents": []},
          {"uid": {"type": "Company", "id": "globex"}, "attrs": {"business_min_level": 7}, "parents": []}]}'
  ```

Then message the agent as Sam (`U0SAM` in workspace `T0ACME`).

## Settings

Copy `.env.example` to `.env.local`.

| Variable                                                   | Default                                      | What it is                                                  |
| ---------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| `APP_URL`                                                  | `https://flightsector.localhost`             | the walkthrough's origin                                    |
| `BOOKING_ISSUER`                                           | `https://booking.flightsector.localhost`     | the booking provider's AAuth identifier                     |
| `BROWSERBASE_MCP_URL`                                      | `https://browserbase.flightsector.localhost` | the mock Browserbase MCP's host                             |
| `BOOKING_PERSON_SERVERS`                                   | `ACME_PERSON_SERVER_URL`                     | Person Servers whose people the provider serves             |
| `ACME_PERSON_SERVER_URL`                                   | `https://ps.acme.localhost`                  | Acme's Person Server identifier                             |
| `ACME_TRUSTED_RESOURCES`                                   | `BOOKING_ISSUER`                             | resources whose resource tokens Acme accepts                |
| `TRUSTED_AGENT_PROVIDERS`                                  | `https://cp.introspection.localhost`         | Agent Providers whose agents may act here (comma-separated) |
| `ACME_PS_SUBJECT_SECRET`                                   | random per process                           | derives each person's directed `sub` per audience           |
| `ACME_PS_SIGNING_KEY`, `BOOKING_SIGNING_KEY`               | generated per process                        | PKCS#8 Ed25519 PEMs for stable keys                         |
| `RESEND_API_KEY`, `ACME_MAIL_FROM`                         | unset: print to console                      | how Acme emails Dana                                        |
| `ACME_WORKSPACE_ID`, `ACME_SAM_USER_ID`, `ACME_DANA_EMAIL` | the emulator's seed                          | Sam and Dana on a real Slack workspace                      |

## How the explainer works

`flow/manifest.mjs` lists the steps. Each step names its sources:

- `example`: a file here, cut to a `#region`;
- `recipe`: a file from the recipe, fetched from GitHub at the pinned commit;
- `contract`: the shape of a platform message on the wire, from `flow/contracts/`.

The page reads the real files at request time, and `pnpm walkthrough` writes `WALKTHROUGH.md` from the same manifest, so the explanation can't drift from the code. Platform internals are never shown: platform steps appear only as their contracts.

After changing the recipe, move the commit in `flow/recipe.mjs`, then `pnpm walkthrough`.
