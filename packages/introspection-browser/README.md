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
2. `connect()` redeems that token at the Data Plane
   (`POST /v1/oauth/exchange`) for the HttpOnly `intro_dp_session` cookie.
3. Every subsequent call rides that cookie (`credentials: "include"`). When the
   session expires, the client transparently re-mints it once on a `401`.

```typescript
import { IntrospectionApiClient } from "@introspection-sdk/introspection-browser/api";

const client = new IntrospectionApiClient({
  dpUrl: "https://dp.us.introspection.dev",
  projectId: "proj_…",
  // your backend returns a fresh Introspection access token
  getToken: () => fetch("/api/introspection/token").then((r) => r.text()),
});

await client.connect(); // → intro_dp_session cookie

const run = await client.tasks.start({
  prompt: "Summarize my latest order",
  agent_name: "support-agent", // or runtime_id: "rt_…"
  identity: { user_id: "u_42" }, // folded into metadata.identity
  visibility: "identity", // sharing scope; defaults by credential
  idle_timeout_seconds: 120, // idle window before the sandbox is torn down
});

for await (const ev of run.stream()) {
  console.log(ev.event, ev.data);
}
```

`client.tasks` exposes the full CRUD surface (`create` / `start` / `get` /
`list` / `update` / `delete` / `archive` / `unarchive`) plus per-run streaming
(`run.stream()`, `run.text()`, `run.cancel()`).

Both `create` and `start` accept two optional task controls:

- **`visibility`** (`"identity" | "member" | "project"`) — the task's minimum
  sharing scope. Defaults to `"identity"` when the credential carries an
  identity claim, else `"project"`. The owning `identity_key` is always derived
  from the session JWT, never the request body.
- **`idle_timeout_seconds`** (`number`) — overrides the interactive idle window
  before the sandbox is torn down. `0` tears it down as soon as it's
  provisioned; omit to use the deployment default. Clamped to the task timeout.

## Files and conversations

The same identity session also reaches `/v1/files` and (read-only)
`/v1/conversations` — no extra credential, just the cookie minted by
`connect()`:

```typescript
// Files — CRUD + upload/download, all identity-scoped
await client.files.upload({ file: new Blob(["hi"]), name: "hi.txt" });
const page = await client.files.list({ visibility: "identity" });
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

> **CORS:** the Data Plane authorizes browser origins against its configured
> allowlist (`CORS_ORIGINS`). A new SPA origin must be present there for the
> cross-origin cookie exchange and task/file/conversation calls to succeed.
