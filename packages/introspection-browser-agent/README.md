# @introspection-sdk/browser-agent

Drive any Chromium over raw CDP with text-first, guarded actions and pluggable
models. It works against the platform's browser sidecar, a local Chrome, or a
hosted provider's `cdp_ws_url` (Kernel, Browserbase). Its only runtime
dependencies are `@opentelemetry/api` and `@introspection-sdk/types`.

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
- **`session.run`.** A driver ladder that escalates on `blocked`, repeated invalid
  actions, or a spent step budget, and verifies `done` with your `success`
  check.
- **`createBrowserTool`.** One `browser` tool with a `command` discriminator
  (`observe`, `act`, `press`, `scroll`, `navigate`, `tabs`, `screenshot`,
  `run`), with the schema narrowed to the commands you allow.
- **Keys and a vision fallback.** `press` sends key chords (`Enter`,
  `Escape`, arrows, `Shift+Tab`, `Control+a`) to the focused element.
  `clickAt` clicks a point of the tab's latest screenshot, for what the element
  table cannot name. It skips the handle checks, so it only works on a
  screenshot taken since the last navigation.

## Start a browser

Any Chromium serving CDP works. Locally, start Chrome with its own profile
directory; Chrome 136 and later refuse remote debugging on your everyday
profile:

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.introspection/browser/default"
```

Inside an Introspection task, the platform's browser is at
`INTROSPECTION_TASK_BROWSER_CDP_URL`.

## Drive it yourself

Search DuckDuckGo and read the results. Every action goes to an element a
previous `observe` returned, by its `el_…` handle:

```ts
import { BrowserSession } from "@introspection-sdk/browser-agent";

const session = await BrowserSession.connect("http://127.0.0.1:9222", {
  allowedDomains: ["duckduckgo.com", "*.duckduckgo.com"],
});
await session.navigate({ url: "https://duckduckgo.com/" });

let page = await session.observe();
const box = page.elements.find(
  (e) => e.role === "searchbox" || e.role === "combobox",
)!;
await session.act({
  element: box.element,
  action: "type",
  text: "chrome devtools protocol",
});
const search = page.elements.find(
  (e) => e.role === "button" && /search/i.test(e.name),
)!;
await session.act({ element: search.element, action: "click" });

page = await session.observe();
const results = page.elements.filter((e) => e.role === "link").slice(0, 5);
console.log(results.map((r) => r.name));
```

## Hand a goal to the fast driver, with Claude as the fallback

`session.run` observes, asks a driver for one step, acts, and repeats. Jev decides the
routine steps in about a tenth of a second each; Claude takes over the steps
Jev is unsure of, and writes the text Jev asks to type. `success` checks the
page itself, so a run is never judged by the driver's own `done`:

```ts
import Anthropic from "@anthropic-ai/sdk";
import {
  BrowserSession,
  ClaudeDriver,
  GatedDriver,
  JevDriver,
} from "@introspection-sdk/browser-agent";

const session = await BrowserSession.connect("http://127.0.0.1:9222", {
  allowedDomains: ["en.wikipedia.org"],
});
await session.navigate({ url: "https://en.wikipedia.org/wiki/Main_Page" });

const claude = new ClaudeDriver({ client: new Anthropic() });
const jev = new JevDriver({
  apiKey: process.env.TYPESAFE_API_KEY,
  textDriver: claude,
});

const result = await session.run({
  goal: "Search Wikipedia for Chromium and open its article",
  drivers: [new GatedDriver(jev, claude)],
  success: (page) =>
    page.url.startsWith("https://en.wikipedia.org/wiki/Chromium"),
});
console.log(result.status, result.steps.length, `${result.elapsedMs} ms`);
```

Values the task already knows can skip the text model entirely:
`new JevDriver({ apiKey, slots: { search: "Chromium" } })` types `Chromium`
into any field whose name contains "search".

Put `new ClaudeDriver({ client, vision: true })` last in the ladder. That rung
sees a screenshot at every step and can answer with a key press or a click at
a point in the screenshot. `JevDriver` can also choose
Enter and Escape.

`ClaudeDriver` takes an `@anthropic-ai/sdk` client you construct, so the
package does not depend on it. It defaults to `claude-opus-5` at `effort: low`
with server-side refusal fallbacks on (`refusalFallbacks: false` turns them
off).

## Telemetry

Every model call a driver makes is an OpenTelemetry GenAI client span, the
same shape `@introspection-sdk/introspection-pi` gives a Pi chat call, so
browser steps are counted and billed like any other model usage:

| Driver                   | Span                                            | Usage recorded                                                              |
| ------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------- |
| `JevDriver`              | `generate_content {model}`, provider `typesafe` | input and output tokens, and the Jev version that answered                  |
| `ClaudeDriver`           | `chat {model}`, provider `anthropic`            | input tokens (cache reads and writes included), output tokens, cache counts |
| `OpenAICompatibleDriver` | `chat {model}`, provider `openai` or `provider` | input tokens (cached included once), output tokens, cached count            |

Spans go to the global tracer provider, so an app that has set one up (the
Introspection runtime does) exports them with no further wiring, and they nest
under whatever span is active, such as the Pi tool call. `telemetry.tracer`
chooses another tracer; `telemetry.attributes` adds host attributes to every
span, which is how the runtime marks a managed call
(`{ "introspection.byok": false }`); `telemetry: false` turns a driver's spans
off, for a client that is already instrumented.

```ts
new JevDriver({
  baseUrl,
  telemetry: { attributes: () => ({ "introspection.byok": !managed }) },
});
```

## Non-JavaScript clients

The page script is published as `dist/browser.v1.js`, with its SHA-256 in
`dist/browser.v1.js.sha256`, so other clients (the `introspection` CLI) can
embed exactly this build and call `window.__introspection.browser.v1` over
CDP.
