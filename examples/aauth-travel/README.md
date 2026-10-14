# Flight Sector: an AAuth travel demo

Flight Sector books work travel for other companies' employees. An employee messages Flight Sector's travel agent, and the agent proposes the trip to **that employee's company**. The traveller's manager approves the trip once, with its budget; bookings within it then need no one, and one over what is left goes back to the manager. Once they decide, the conversation picks up by itself.

The agent holds no credential and the model decides nothing: every booking runs on [AAuth](https://github.com/dickhardt/AAuth) (-11, three-party, with a mission), checked first by Flight Sector's Cedar rails in the platform's egress. [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) covers the parties and the flow; [WALKTHROUGH.md](./WALKTHROUGH.md) steps through the code.

## Run it

You need Node 24, pnpm, [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (`brew install cloudflared`) and an Introspection account. No domain and no Cloudflare account.

```bash
npm install -g @introspection-ai/cli
introspection login          # your organization and project
pnpm install
pnpm dev
```

Then open `http://localhost:3400/demo` and send a sample prompt as Sam. Without `RESEND_API_KEY`, Dana's emails, with their codes, appear on the page and in the console.

`pnpm dev` serves the app on `:3400`, gives the booking provider and the Browserbase mock public https URLs through free Cloudflare tunnels (the platform's egress and Person Server call them), and sets up your project on whichever Introspection `introspection login` chose. The first time on a stack it creates:

1. **The agent:** a repository Introspection hosts, seeded from the public [travel-agent recipe](https://github.com/introspection-org/recipe-travel-agent), and its runtime.
2. **Flight search:** Browserbase's hosted MCP with `BROWSERBASE_API_KEY` set, otherwise this app's mock.
3. **The booking provider** as an AAuth connector, from [`introspection/booking.json`](./introspection/booking.json), acting as a new `Flight Sector agent` application.
4. **Sam** as a customer member with the seniority the recipe's rules read, from [`introspection/sam.json`](./introspection/sam.json).
5. **A project API key** for the demo page and Acme's approval app, in `.env.local` with the rest of the settings.

After that each run only points the connector and the mock at its new URLs.

Options:

- `FLIGHTSECTOR_DOMAIN=example.dev pnpm dev` uses a named tunnel on a domain in your Cloudflare account (`cloudflared tunnel login` once), so the URLs stay the same every run.
- `PERSON_SERVER=acme pnpm dev` has Acme run its own Person Server here, built on [`@introspection-sdk/person-server`](../../packages/introspection-person-server), instead of Introspection's hosted one.

[HOW-IT-WORKS.md](./HOW-IT-WORKS.md) covers the parties, the flow, and each setup step as the CLI command it runs.

## Without Introspection

`pnpm e2e` checks the AAuth protocol between the booking provider and Acme's Person Server with no backend: a script plays the agent, signing its requests the way the platform's egress would, from a test Agent Provider of its own. No model, recipe or rules run; it is a protocol test, not the demo.

## When it doesn't work

- **`pnpm dev` says AAuth is not enabled:** the stack you are logged in to serves no Agent Provider or hosted Person Server yet; try `PERSON_SERVER=acme`, or another stack.
- **An agent token is refused:** its Agent Provider must be in `TRUSTED_AGENT_PROVIDERS`; `pnpm dev` sets it from your stack.
- **No email:** without `RESEND_API_KEY` it is in the console, not your inbox.
