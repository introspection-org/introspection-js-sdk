# @introspection-sdk/browser-agent

Drive any Chromium over raw CDP with text-first, guarded actions and pluggable
models. It works against the platform's browser sidecar, a local Chrome, or a
hosted provider's `cdp_ws_url` (Kernel, Browserbase), and it has no runtime
dependencies.

- **`browser.v1` page script.** Injected into every tab, it turns the page into
  an element table with opaque `el_…` handles. Actions only land on an element
  a previous `observe` returned, after checking that it is still there,
  enabled, and not covered. A navigation invalidates every handle.
- **Drivers.** `JevDriver` (TypeSafe's decision model: operation and target in
  one request, about 120 ms), `ClaudeDriver`, `OpenAICompatibleDriver`, and
  `GatedDriver`, which re-decides only the steps the fast driver is unsure of.
  `JevDriver` follows the loop of
  [`browser-use/jev-ultrafast`](https://github.com/browser-use/jev-ultrafast),
  Browser Use and TypeSafe's Python reference agent. That repository is our
  behavioural reference, not a dependency.
- **`run`.** A driver ladder that escalates on `blocked`, repeated invalid
  actions, or a spent step budget, and verifies `done` with your `success`
  check.
- **`createBrowserTool`.** One `browser` tool with a `command` discriminator
  (`observe`, `act`, `scroll`, `navigate`, `tabs`, `screenshot`, `run`), with
  the schema narrowed to the commands you allow.

## Drive a browser

```ts
import { BrowserSession } from "@introspection-sdk/browser-agent";

const session = await BrowserSession.connect("http://127.0.0.1:9222", {
  allowedDomains: ["app.example.com"],
  // For the browser edge: headers: { Authorization: `Bearer ${token}` },
});
await session.navigate({ url: "https://app.example.com/search" });

const page = await session.observe();
const box = page.elements.find((e) => e.name === "Destination")!;
await session.act({ element: box.element, action: "type", text: "Lisbon" });
```

## Hand a goal to the fast driver, with Claude as the fallback

```ts
import Anthropic from "@anthropic-ai/sdk";
import {
  BrowserSession,
  ClaudeDriver,
  GatedDriver,
  JevDriver,
  run,
} from "@introspection-sdk/browser-agent";

const claude = new ClaudeDriver({ client: new Anthropic() });
const jev = new JevDriver({
  apiKey: process.env.TYPESAFE_API_KEY,
  textDriver: claude,
});

const result = await run(session, {
  goal: "Find Design stays in Lisbon with free cancellation",
  drivers: [new GatedDriver(jev, claude)],
  success: (page) => page.text.includes("in Lisbon"),
});
```

`ClaudeDriver` takes an `@anthropic-ai/sdk` client you construct, so the
package does not depend on it. It defaults to `claude-opus-5` at `effort: low`
with server-side refusal fallbacks on (`refusalFallbacks: false` turns them
off).

## Non-JavaScript clients

The page script is published as `dist/browser.v1.js`, with its SHA-256 in
`dist/browser.v1.js.sha256`, so other clients (the `introspection` CLI) can
embed exactly this build and call `window.__introspection.browser.v1` over
CDP.
