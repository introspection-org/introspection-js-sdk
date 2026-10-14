# Flight Sector: an AAuth travel demo

Flight Sector books work travel for other companies' employees. An employee messages Flight Sector's travel agent, and the agent proposes the trip to **that employee's company**. The traveller's manager approves the trip once, with its budget; bookings within it then need no one, and one over what is left goes back to the manager. Once they decide, the conversation picks up by itself.

The agent holds no credential and the model decides nothing: every booking runs on [AAuth](https://github.com/dickhardt/AAuth) (-11, three-party, with a mission), checked first by Flight Sector's Cedar rails in the platform's egress. [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) covers the parties and the flow; [WALKTHROUGH.md](./WALKTHROUGH.md) steps through the code.

## Quick start

Needs Node 24 and pnpm. From this folder:

```bash
pnpm install
pnpm dev    # https://flightsector.localhost: the walkthrough
pnpm e2e    # the whole AAuth flow, with a script playing the agent (stop pnpm dev first)
```

The first run asks for your password once: every party is named `https://host` with no port, so it installs [portless](https://github.com/vercel-labs/portless) as a startup service on `:443` and trusts its local CA. Without `RESEND_API_KEY`, Dana's emails, with their codes, print to the console.

> **No agent runs in the quick start.** `pnpm e2e` is a script making the requests the platform's egress would make for the agent: it exercises the booking provider and Acme's Person Server, with no model, no recipe and no Cedar rails. The walkthrough only reads the recipe's code from GitHub to show it. The real agent, the [travel-agent recipe](https://github.com/introspection-org/recipe-travel-agent), runs only on Introspection, because its egress is what holds the agent's identity and signs its requests; that is the next section.

## With the agent, on Introspection

This is where the agent runs: the [travel-agent recipe](https://github.com/introspection-org/recipe-travel-agent) becomes a runtime in your Introspection project, and `/demo` is Sam's chat with it, beside what every party saw. You need the `introspection` CLI, an account, and [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`brew install cloudflared`); no domain and no Cloudflare account.

```bash
npm install -g @introspection-ai/cli
introspection login                  # your organization and project
pnpm install
pnpm dev:public                      # leave running: the app, and a public URL for the booking provider
pnpm run introspection:setup         # in a second terminal
```

Then open `http://localhost:3400/demo` and send a sample prompt as Sam.

`dev:public` serves the app on `:3400` and gives the booking provider a public https URL through a free Cloudflare tunnel, since the platform's egress and Person Server call it. `introspection:setup` uses the CLI to set up your project, and is safe to re-run:

1. **The agent:** a repository Introspection hosts, seeded from the public recipe, and its runtime.
2. **Flight search:** Browserbase's hosted MCP with `BROWSERBASE_API_KEY` set, otherwise this app's mock.
3. **The booking provider** as an AAuth connector, from [`introspection/booking.json`](./introspection/booking.json), acting as a new `Flight Sector agent` application.
4. **Sam** as a customer member with the seniority the recipe's rules read, from [`introspection/sam.json`](./introspection/sam.json).
5. **A project API key** for the demo page and Acme's approval app, written to `.env.local` with the rest of the settings.

Options:

- `FLIGHTSECTOR_DOMAIN=example.dev pnpm dev:public` uses a named tunnel at `booking.flightsector.example.dev`, the same every run, on a domain in your Cloudflare account (`cloudflared tunnel login` once). Without it the URL changes each run, and `dev:public` re-points the connector by itself.
- `PERSON_SERVER=acme` (for both commands) has Acme run its own Person Server here, built on [`@introspection-sdk/person-server`](../../packages/introspection-person-server), instead of Introspection's hosted one.

[HOW-IT-WORKS.md](./HOW-IT-WORKS.md#configuring-it-on-introspection) shows each step as the CLI command it runs.

## When it doesn't work

- **Certificate errors:** `pnpm exec portless doctor` should show the proxy on `:443` and its CA trusted; `pnpm run setup:https` re-runs the install.
- **An agent token is refused:** its Agent Provider must be in `TRUSTED_AGENT_PROVIDERS`; `introspection:setup` sets it from your stack.
- **`introspection:setup` says AAuth is not enabled:** the stack you are logged in to does not serve an Agent Provider or a hosted Person Server yet; try `PERSON_SERVER=acme`, or another stack.
- **No email:** without `RESEND_API_KEY` it is in the console, not your inbox.
