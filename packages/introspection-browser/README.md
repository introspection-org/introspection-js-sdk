# @introspection-sdk/introspection-browser

Browser SDK for [Introspection](https://introspection.dev) — track events, feedback, and user identity with localStorage persistence.

## Install

```shell
pnpm add @introspection-sdk/introspection-browser
```

## Usage

```typescript
import { IntrospectionClient } from "@introspection-sdk/introspection-browser";

const client = new IntrospectionClient({
  token: "intro_xxx",
});

// Set identity once
client.identify("user_123", { email: "user@example.com" });

// Track events
client.track("Button Clicked", { buttonId: "submit" });

// Log an app event under your own namespace (`track` is an alias of this).
// Names under `introspection.` / `gen_ai.` are reserved and throw.
client.logEvent(
  "checkout.completed",
  { orderId: "o_1", total: 42 },
  { eventId: "checkout:o_1" }, // stable id: consumers dedupe on it
);

// Track feedback
client.feedback("thumbs_up", { comments: "Very helpful response" });
client.feedback("thumbs_down", {
  previousResponseId: "msg_123",
  comments: "Off topic",
});
```

## Client-side API (`/api`)

The `@introspection-sdk/introspection-browser/api` entry point lets a
single-page app **create and stream Introspection tasks directly from the
browser, with no API key in JavaScript**. Authentication is the standard B2B2C
flow (see the [`auth`](../../examples/auth) example):

**The browser talks only to the Data Plane.** Runtime resolution is a Control
Plane call and stays on your backend, so the CP never has to serve CORS to
customer web origins.

1. The app's **own backend ("broker")** mints an Introspection access token —
   via RFC 8693 token-exchange of the partner IdP token, a PKCE
   `authorization_code`, or `client_credentials`. The IdP secret never leaves
   the backend. The backend returns **`{ token, runtimeId, dpUrl }`**: it
   resolves the runtime id server-side (e.g. with the Node SDK's
   `client.runtimes.resolve("support-agent")`) and supplies the Data
   Plane URL, so the SPA needs no Introspection config of its own.
2. `client.connect()` redeems the token at the **Data Plane**
   `POST /v1/oauth/exchange` for an HttpOnly session cookie, named for the
   token's environment lane and project (see [Environments](#environments)).
3. `client.tasks.start({ runtime_id })` and friends ride that cookie against
   the Data Plane for tasks, files, conversations, and shares.

```typescript
import { IntrospectionApiClient } from "@introspection-sdk/introspection-browser/api";

// Your backend returns { token, runtimeId, dpUrl }: it mints the access token,
// resolves the runtime id, and supplies the DP URL — so the browser never
// calls the CP and carries no Introspection config of its own.
const { token, runtimeId, dpUrl } = await fetch(
  "/api/introspection/session",
).then((r) => r.json());

const client = new IntrospectionApiClient({
  dpUrl,
  getToken: () => token,
});

await client.connect(); // -> intro_dp_<lane>_<project> session cookie

const run = await client.tasks.start({
  prompt: "Summarize my latest order",
  runtime_id: runtimeId,
  idle_timeout_seconds: 120, // idle window before the sandbox is torn down
});

for await (const ev of run.stream()) {
  console.log(ev.type);
}
```

`client.tasks` exposes the full CRUD surface (`create` / `start` / `get` /
`list` / `update` / `delete` / `archive` / `unarchive`) plus per-run streaming
(`run.stream()` yields AG-UI events, `run.text()`, and `run.cancel(options)`).
Cancellation defaults to abort; pass `mode: "drain"` and an optional
`drain_within_seconds` for graceful teardown.

`create` and `start` accept **`idle_timeout_seconds`** (`number`) to override
the interactive idle window before the sandbox is torn down. `0` tears it down
as soon as it's provisioned; omit to use the deployment default. Clamped to the
task timeout. When no `runtime_id` is supplied, pass `agent_name` to select a
named recipe agent instead.

### Environments

The session cookie is a signed `browser_session` JWT named for its environment
lane **and** project — `intro_dp_{lane}_{base64url(project_uuid_bytes)}`, e.g.
`intro_dp_production_AZLVpGw-ehCAAAAAAAAAAQ` — so an app running more than one
lane or project holds a live session for **each** in one browser. A single
shared name gave the browser one slot, so a second `connect()` evicted the
first.

**You never pass the environment or project in.** Your backend picks them when
it mints the token; the Data Plane reads them off the token's claims and
returns them, and the client sends them back as the `lane` and `project_id`
query parameters so the right cookie is resolved. Both are selectors, not
credentials: the cookie's own signed lane and project are checked against
them, so naming one this browser holds no cookie for grants nothing. Query
parameters, not headers, so requests stay CORS-simple and skip the preflight a
custom header forces on every call:

```typescript
const dev = new IntrospectionApiClient({
  dpUrl,
  getToken: () => mintToken({ environment: "development" }),
});
const prod = new IntrospectionApiClient({
  dpUrl,
  getToken: () => mintToken({ environment: "production" }),
});

await Promise.all([dev.connect(), prod.connect()]);

dev.environment; // "development" -> cookie intro_dp_development_<project>
prod.environment; // "production"  -> cookie intro_dp_production_<project>
dev.projectId; // the project the token was minted for

await dev.tasks.list(); // GET /v1/tasks?lane=development&project_id=<uuid>
await prod.tasks.list(); // GET /v1/tasks?lane=production&project_id=<uuid>
```

`client.environment` is `undefined` until `connect()` resolves. The optional
`environment` constructor option sends the lane before that first exchange;
if it disagrees with the token, `connect()` throws rather than silently
preferring one — the token is the authority.

Without `project_id` the Data Plane picks the lane's most recently issued
cookie, so a page that connected to two projects on one lane would silently
read whichever exchanged last; sending it is what keeps two clients on one lane
apart.

> **Requires a Data Plane that returns `environment` and `project_id` from
> `/v1/oauth/exchange`.** Against an older deployment that omits `project_id`,
> `client.projectId` stays `undefined` and only `lane` is sent; one that also
> omits `environment` leaves `client.environment` `undefined` and sends
> neither, so a single-lane app keeps working unchanged.

## Files and conversations

The same cookie session also reaches `/v1/files` and (read-only)
`/v1/conversations` on the Data Plane:

```typescript
// Files — CRUD + upload/download, all identity-scoped
await client.files.upload({ file: new Blob(["hi"]), name: "hi.txt" });
const page = await client.files.list();
const bytes = await client.files.download(page.records[0].id);

// Conversations — read-only projection over the telemetry store
for await (const summary of client.conversations.list()) {
  console.log(summary.conversation_id);
}
// Resolve the latest turn of a conversation (Responses-API shape)
const turn = await client.conversations.retrieve(conversationId);
console.log(turn?.output_messages);

// Complete exports — server-owned pagination, buffered or raw streaming
const json = await client.conversations.exportJson(conversationId);
const stream = await client.conversations.exportStream(conversationId, "json");
```

`client.files` covers the same file surface (`list` / `upload` /
`createText` / `get` / `update` / `delete` / `download` / `downloadStream`,
plus `files.versions`). `client.conversations` mirrors `ConversationsApi`
(`list`, `retrieve`, `exportJson`, `exportArrow`, `exportTrajectory`,
`exportStream`, and `conversations.items.list()` / `.get()`). Both `list`
helpers return a `Paginator` — `await` it for the first page or `for await` it
to auto-page.

> **CORS:** the browser only calls the Data Plane, so just the selected Data
> Plane needs to allow the SPA origin. The Control Plane never receives browser
> requests — runtime resolution happens on your backend.
