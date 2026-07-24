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

**The browser talks only to the Data Plane.** It binds a stable Runtime during
session exchange, so the CP never has to serve CORS to customer web origins.

1. The app's **own backend ("broker")** calls Node's
   `client.runtimes.delegate(...)` for the authenticated user. The broker
   returns a fresh **`{ token, deployment }`** on every request; secrets never
   leave the backend.
2. `client.connect()` redeems the token at the **Data Plane**
   `POST /v1/oauth/exchange` for the HttpOnly `intro_dp_session` cookie.
3. `client.tasks.start(...)` and friends ride that cookie against
   the Data Plane for tasks, files, conversations, and shares.

```typescript
import { IntrospectionApiClient } from "@introspection-sdk/introspection-browser/api";

const fetchDelegation = () =>
  fetch("/api/introspection/delegation").then((r) => r.json());
const initial = await fetchDelegation();
const dpUrl = initial.deployment.endpoint;
let initialToken: string | undefined = initial.token;

const client = new IntrospectionApiClient({
  dpUrl,
  auth: {
    kind: "delegation",
    // Called for the initial exchange and again after a 401. The broker must
    // mint a new delegation each time; delegated tokens are single-use here.
    getToken: async () => {
      if (initialToken) {
        const token = initialToken;
        initialToken = undefined;
        return token;
      }
      const fresh = await fetchDelegation();
      if (fresh.deployment.endpoint !== dpUrl) {
        throw new Error("Runtime deployment changed; rebuild the client");
      }
      return fresh.token;
    },
  },
});

await client.connect(); // -> intro_dp_session cookie

const run = await client.tasks.start({
  prompt: "Summarize my latest order",
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
task timeout. Pass `agent_name` to select a named agent inside the
session-bound Runtime.

Delegated tokens are already Runtime-bound and are exchanged without a second
Runtime selector. `getToken` must fetch a newly minted delegation on every
invocation, including automatic 401 recovery:

```typescript
const initial = await fetch("/api/introspection/delegation").then((r) =>
  r.json(),
);
const dpUrl = initial.deployment.endpoint;
let initialToken: string | undefined = initial.token;
const client = new IntrospectionApiClient({
  dpUrl,
  auth: {
    kind: "delegation",
    getToken: async () => {
      if (initialToken) {
        const token = initialToken;
        initialToken = undefined;
        return token;
      }
      const fresh = await fetch("/api/introspection/delegation").then((r) =>
        r.json(),
      );
      if (fresh.deployment.endpoint !== dpUrl) {
        throw new Error("Runtime deployment changed; rebuild the client");
      }
      return fresh.token;
    },
  },
});
```

The client is endpoint-bound for its lifetime. A delegation refresh must remain
on that endpoint; if it changes, rebuild and connect the client. Never silently
send a token minted for a different deployment to the old Data Plane.

If your app starts by fetching a delegation to discover the endpoint, consume
that delegation only for the first exchange. Every later `getToken` invocation
must call the broker again.

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
