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

// Track feedback
client.feedback("thumbs_up", { comments: "Very helpful response" });
client.feedback("thumbs_down", {
  responseId: "msg_123",
  comments: "Off topic",
});
```

## Client-side API (`/api`)

The `@introspection-sdk/introspection-browser/api` entry point lets a
single-page app **create and stream Introspection tasks directly from the
browser, with no API key in JavaScript**. Authentication is the standard B2B2C
flow (see the [`sample-auth`](../../examples/apps/sample-auth) example):

**The browser talks only to the Data Plane.** Runtime resolution is a Control
Plane call and stays on your backend, so the CP never has to serve CORS to
customer web origins.

1. The app's **own backend ("broker")** mints an Introspection access token —
   via RFC 8693 token-exchange of the partner IdP token, a PKCE
   `authorization_code`, or `client_credentials`. The IdP secret never leaves
   the backend. The backend returns **`{ token, runtimeId, dpUrl }`**: it
   resolves the runtime id server-side (e.g. with the Node SDK's
   its own operator/configuration path and supplies the Data
   Plane URL, so the SPA needs no Introspection config of its own.
2. `client.connect()` redeems the token at the **Data Plane**
   `POST /v1/oauth/exchange` for the HttpOnly `intro_dp_session` cookie.
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

await client.connect(); // -> intro_dp_session cookie

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
(`run.stream()` yields AG-UI events, `run.text()`, `run.abort()`).

`create` and `start` accept **`idle_timeout_seconds`** (`number`) to override
the interactive idle window before the sandbox is torn down. `0` tears it down
as soon as it's provisioned; omit to use the deployment default. Clamped to the
task timeout. When no `runtime_id` is supplied, pass `agent_name` to select a
named recipe agent instead.

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
```

`client.files` mirrors the Node SDK's `FilesApi` (`list` / `upload` /
`createText` / `get` / `update` / `delete` / `download` / `downloadStream`,
plus `files.versions`). `client.conversations` mirrors `ConversationsApi`
(`list`, `retrieve`, and `conversations.items.list()` / `.get()`). Both `list`
helpers return a `Paginator` — `await` it for the first page or `for await` it
to auto-page.

> **CORS:** the browser only calls the Data Plane, so just the selected Data
> Plane needs to allow the SPA origin. The Control Plane never receives browser
> requests — runtime resolution happens on your backend.
