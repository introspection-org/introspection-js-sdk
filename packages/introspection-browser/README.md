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

1. The app's **own backend ("broker")** mints an Introspection access token —
   via RFC 8693 token-exchange of the partner IdP token, a PKCE
   `authorization_code`, or `client_credentials`. The IdP secret never leaves
   the backend.
2. `client.runtimes(name).run()` uses that token at the Control Plane to
   resolve a runtime and mint a short-lived runner token.
3. The returned runner talks directly to the selected Data Plane endpoint for
   tasks, files, conversations, and shares.

```typescript
import { IntrospectionApiClient } from "@introspection-sdk/introspection-browser/api";

const client = new IntrospectionApiClient({
  cpUrl: "https://api.introspection.dev",
  // your backend returns a fresh Introspection access token
  getToken: () => fetch("/api/introspection/token").then((r) => r.text()),
});

const runner = await client.runtimes("support-agent").run({
  identity: { user_id: "u_42" },
});

const run = await runner.tasks.start({
  prompt: "Summarize my latest order",
  idle_timeout_seconds: 120, // idle window before the sandbox is torn down
});

for await (const ev of run.stream()) {
  console.log(ev.event, ev.data);
}
```

`runner.tasks` exposes the full CRUD surface (`create` / `start` / `get` /
`list` / `update` / `delete` / `archive` / `unarchive`) plus per-run streaming
(`run.stream()`, `run.text()`, `run.cancel()`).

`create` and `start` accept **`idle_timeout_seconds`** (`number`) to override
the interactive idle window before the sandbox is torn down. `0` tears it down
as soon as it's provisioned; omit to use the deployment default. Clamped to the
task timeout.

The older cookie-session path is still available for apps that already know a
Data Plane URL:

```typescript
const client = new IntrospectionApiClient({
  dpUrl: "https://dp.us.introspection.dev",
  getToken: () => fetch("/api/introspection/token").then((r) => r.text()),
});

await client.connect(); // -> intro_dp_session cookie
await client.tasks.start({
  prompt: "Summarize my latest order",
  runtime_id: "019ed295-5d76-7432-863b-f9327af50221",
});
```

For new runtime-backed browser apps, prefer
`client.runtimes("support-agent").run()` so the browser follows the same
runtime resolution flow as the Node SDK and does not carry runtime ids.

## Files and conversations

The same runner session also reaches `/v1/files` and (read-only)
`/v1/conversations` using the CP-minted runner token:

```typescript
// Files — CRUD + upload/download, all identity-scoped
await runner.files.upload({ file: new Blob(["hi"]), name: "hi.txt" });
const page = await runner.files.list();
const bytes = await runner.files.download(page.records[0].id);

// Conversations — read-only projection over the telemetry store
for await (const summary of runner.conversations.list()) {
  console.log(summary.conversation_id);
}
// Resolve the latest turn of a conversation (Responses-API shape)
const turn = await runner.conversations.retrieve(conversationId);
console.log(turn?.output_messages);
```

`runner.files` mirrors the Node SDK's `FilesApi` (`list` / `upload` /
`createText` / `get` / `update` / `delete` / `download` / `downloadStream`,
plus `files.versions`). `runner.conversations` mirrors `ConversationsApi`
(`list`, `retrieve`, and `conversations.items.list()` / `.get()`). Both `list`
helpers return a `Paginator` — `await` it for the first page or `for await` it
to auto-page.

> **CORS:** the Control Plane must allow the SPA origin for runtime resolution,
> and each selected Data Plane must allow the origin for runner task/file/
> conversation calls.
