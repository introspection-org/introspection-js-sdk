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

## On Introspection

This is where the agent runs: with an Introspection project, the travel-agent recipe is a runtime, and `/demo` is Sam's chat with it. The platform's egress has to reach the booking provider and Acme's pages, so deploy this app where it is publicly reachable, then set up the project as [HOW-IT-WORKS.md](./HOW-IT-WORKS.md#configuring-it-on-introspection) describes.

## When it doesn't work

- **Certificate errors:** `pnpm exec portless doctor` should show the proxy on `:443` and its CA trusted; `pnpm run setup:https` re-runs the install.
- **An agent token is refused:** its Agent Provider must be in `TRUSTED_AGENT_PROVIDERS`.
- **No email:** without `RESEND_API_KEY` it is in the console, not your inbox.
