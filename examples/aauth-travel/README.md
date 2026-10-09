# Flight Sector: an AAuth travel demo

Flight Sector books work travel for other companies' employees. An employee messages Flight Sector's travel agent, and the agent books within **that employee's company policy**. A hotel over the company's cap goes to the traveller's manager, and once they approve, the conversation picks up by itself.

None of this is decided by the model, and the agent never holds a credential. It runs on [AAuth](https://github.com/dickhardt/AAuth) at -11, three-party:

- the **Agent Provider** (the platform's control plane) mints an agent token for each session, binding the session's key;
- the platform's **egress** signs each of the agent's requests (RFC 9421) and presents the agent token;
- the **resource** (Flight Sector's booking provider) answers `401` with a resource token naming the exact quote;
- egress takes the resource token to the traveller's **Person Server** (Acme's), which answers `200` with an auth token, `202` while it asks the manager, or `403`.

This example is the **Flight Sector side and the Acme side** of the demo, and the explainer. The platform side (Agent Provider, egress signing, waiting on a `202`) lives in `introspection-cloud`; see `docs/design/connectors-aauth-b2b2c.md` §12.3.

- **Booking provider** (`/booking`) is a native three-party AAuth resource. Search is open and every offer carries a quote it signs. A reservation presenting an agent token gets `401 requirement=auth-token` and a resource token; one presenting an auth token for that exact quote is booked. Metadata at `/booking/.well-known/aauth-resource.json`.
- **Acme's Person Server** (its own origin, `http://127.0.0.1:3400` locally) is Acme's system, not Flight Sector's. It verifies the agent's signature and agent token, checks the resource token belongs to that agent, and applies Acme's travel policy to the quote. Over policy, it emails the traveller's manager a link and a six-digit code (approval page at `/approve/{id}`) and answers `202` with a URL to poll.
- **The walkthrough** (`/`) covers every step of the flow, beside the code behind it. Steps light up as these services see traffic. `WALKTHROUGH.md` is the same thing as a document.

The agent itself is the public [travel-agent recipe](https://github.com/introspection-org/recipe-travel-agent). The walkthrough shows it from a vendored snapshot in `recipe/`.

## The flow

| Sam asks for                       | What happens                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| QF74 business, SFO to SYD ($7,800) | `200`: under Acme's $9,000 flight cap for Sydney, so Acme issues an auth token and it's booked |
| QT Sydney at $420/night (cap $300) | `202`: Acme emails Dana, Sam's manager, a code. Dana approves on Acme's page, and it's booked  |
| The Melbourne weekend, paid by Sam | `200`: Acme doesn't police what it doesn't pay for                                             |
| The QT again, and Dana declines    | `403` on the pending URL                                                                       |

## Run it

```bash
pnpm install
pnpm --filter introspection-example-aauth-travel dev   # http://localhost:3400
```

On its own, the app serves the walkthrough, the booking provider and Acme's Person Server. Without `RESEND_API_KEY`, Dana's email, with its code, is printed to this app's console.

To exercise the whole AAuth flow without the platform, play the agent with the e2e script. It runs a test Agent Provider on `:3499` and books the table above, with an Ed25519 agent key as well as ES256.

```bash
pnpm dev > /tmp/aauth-travel.log 2>&1 &
E2E_SERVER_LOG=/tmp/aauth-travel.log node scripts/e2e-aauth.mjs
```

### Acme's origin

An AAuth server identifier is scheme and host, with no path, so Acme's Person Server cannot live at `localhost:3400/acme`. Locally it is `http://127.0.0.1:3400`: the same process under a different host, which `next.config.ts` rewrites to `/acme/*`. `127.0.0.1` resolves everywhere, including in Node. `http://acme.localhost:3400` also works in a browser, but Node on Linux does not resolve `*.localhost` without an `/etc/hosts` entry, and every server here fetches Acme's metadata. Local runs bend two identifier rules (`http`, and a port), and the booking provider's issuer has a path; a deployment uses `https://` hosts of their own.

### With the platform

In `introspection-cloud`, `make dev-aauth-demo` turns the AAuth agent on in the local egress and points it at this app. Then create the booking connector:

| Setting           | Value                                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Booking connector | slug `booking`, `auth_mode: aauth`, `person_server_url: http://127.0.0.1:3400`, `api_hosts: [api.booking.example]`, `metadata: {"aauth_resource": "http://localhost:3400/booking", "aauth_upstream": "http://localhost:3400/booking"}` |
| Booking provider  | `http://localhost:3400/booking` (no credential: egress signs, the provider verifies)                                                                                                                                                   |
| Agent Provider    | the control plane, `http://localhost:8000`, trusted here by default outside production                                                                                                                                                 |

The recipe's `policies/` (Flight Sector's rails) run in the egress before anything is signed. They read two things an org owner sets:

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

`make dev-aauth-demo` turns the gate on (`POLICY_GATE_ENABLED`). Then message the agent as Sam (`U0SAM` in workspace `T0ACME`).

## Settings

Copy `.env.example` to `.env.local`.

| Variable                                                   | Default                                       | What it is                                                   |
| ---------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| `APP_URL`                                                  | `http://localhost:3400`                       | this app's origin                                            |
| `BOOKING_ISSUER`                                           | `{APP_URL}/booking`                           | the booking provider's AAuth identifier                      |
| `BOOKING_PERSON_SERVERS`                                   | `ACME_PERSON_SERVER_URL`                      | Person Servers whose people the provider serves              |
| `BOOKING_AGENT_PROVIDERS`                                  | `http://localhost:8000,http://localhost:3499` | Agent Providers whose agent tokens the provider accepts      |
| `ACME_PERSON_SERVER_URL`                                   | `http://127.0.0.1:3400`                       | Acme's Person Server identifier (scheme and host)            |
| `ACME_TRUSTED_RESOURCES`                                   | `BOOKING_ISSUER`                              | resources whose resource tokens Acme accepts                 |
| `TRUSTED_AGENT_PROVIDERS`                                  | `http://localhost:8000,http://localhost:3499` | Agent Providers Acme accepts (none in production unless set) |
| `ACME_PS_SUBJECT_SECRET`                                   | random per process                            | derives each person's directed `sub` per audience            |
| `ACME_PS_SIGNING_KEY`, `BOOKING_SIGNING_KEY`               | generated per process                         | PKCS#8 PEMs for stable keys                                  |
| `RESEND_API_KEY`, `ACME_MAIL_FROM`                         | unset: print to console                       | how Acme emails Dana                                         |
| `ACME_WORKSPACE_ID`, `ACME_SAM_USER_ID`, `ACME_DANA_EMAIL` | the emulator's seed                           | Sam and Dana on a real Slack workspace                       |

## How the explainer works

`flow/manifest.mjs` lists the steps. Each step names its sources:

- `example`: a file here, cut to a `#region`;
- `recipe`: a file from the recipe;
- `contract`: the shape of a platform message on the wire, from `flow/contracts/`.

The page reads the real files at request time, and `pnpm walkthrough` writes `WALKTHROUGH.md` from the same manifest, so the explanation can't drift from the code. Platform internals are never shown: platform steps appear only as their contracts.

After changing the recipe, refresh the snapshot with `RECIPE_DIR=path/to/recipe-travel-agent pnpm sync-recipe`, then `pnpm walkthrough`.
