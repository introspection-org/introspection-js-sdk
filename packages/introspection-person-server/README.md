# @introspection-sdk/person-server

An AAuth Person Server ([draft-hardt-oauth-aauth-protocol](https://github.com/dickhardt/AAuth) `-11`, three-party) you can run instead of building one. It speaks for your people when agents want to act for them:

- verifies each agent by its HTTP Message Signature (RFC 9421) and the agent token it presents, from agent providers you trust;
- approves **missions**, and issues **person tokens** and **auth tokens** under them;
- weighs each auth token request against its mission's **budget** ([draft-hardt-aauth-budgets](https://github.com/dickhardt/AAuth)): a request whose resource token carries a `budget` that fits what is left is issued at once, and spent;
- turns anything that needs a human into an **approval**, which you decide however you reach the person: email, chat, your own app.

Handlers take a Web `Request` and return a `Response`, so it mounts in Next.js, Hono, Bun, Deno, Workers or plain Node.

Introspection runs the same protocol as a hosted Person Server in its data plane; a connector names either one in `person_server_url`, and an agent cannot tell them apart.

## Use

```ts
import { createPersonServer } from "@introspection-sdk/person-server";

const ps = await createPersonServer({
  issuer: "https://ps.acme.example", // https://host, no port or path
  trustedAgentProviders: ["https://api.introspection.dev"],
  signingKey: process.env.PS_SIGNING_KEY, // PKCS#8 Ed25519 PEM
  subjectSecret: process.env.PS_SUBJECT_SECRET,
  directory: {
    // Who you speak for: the person a login_hint names.
    person: (hint) => employees.byEmail(hint),
    // Who decides for them; the person themself when omitted.
    approver: (kind, person) =>
      kind === "completion" ? person : employees.managerOf(person),
  },
  // Reach whoever decides. Answer later with ps.decide().
  onApproval: (approval) => notify(approval.approver, approval),
});

// Any framework: one catch-all route.
export default { fetch: (request: Request) => ps.handle(request) };

// When the approver answers:
await ps.decide(approvalId, {
  status: "approved",
  budget: { amount: 300_000, unit: "USD", decimals: 2 }, // a mission's budget
  decided_by: "dana@acme.example",
});
```

## Run it on its own

```bash
npm install @introspection-sdk/person-server
# A stable Ed25519 signing key and subject secret, generated once:
node -e 'const c=require("node:crypto");process.stdout.write(c.generateKeyPairSync("ed25519").privateKey.export({type:"pkcs8",format:"pem"}))' > ps-signing-key.pem
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > ps-subject-secret
```

Node has no built-in server for `Request` → `Response` handlers, so adapt `node:http`. Bun and Deno take `ps.handle` as it is: `Bun.serve({ fetch: ps.handle })`, `Deno.serve(ps.handle)`.

```ts
// server.mjs
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";

import { createPersonServer } from "@introspection-sdk/person-server";

const issuer = "https://ps.acme.example";
const people = {
  "user:sam@acme.example": {
    id: "sam",
    name: "Sam",
    email: "sam@acme.example",
  },
  "user:dana@acme.example": {
    id: "dana",
    name: "Dana",
    email: "dana@acme.example",
  },
};
const ps = await createPersonServer({
  issuer,
  trustedAgentProviders: ["https://api.introspection.dev"],
  signingKey: readFileSync("ps-signing-key.pem", "utf8"),
  subjectSecret: readFileSync("ps-subject-secret", "utf8"),
  adminToken: process.env.PS_ADMIN_TOKEN, // turns on the management routes
  directory: {
    // Who you speak for, by the login hint an agent's connector sends.
    person: (hint) => people[hint],
    approver: (kind, person) =>
      kind === "completion" ? person : people["user:dana@acme.example"],
  },
  onApproval: (approval) =>
    console.log(
      `approval ${approval.id} for ${approval.approver.email}: ${approval.description}`,
    ),
});

createServer(async (req, res) => {
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const response = await ps.handle(
    new Request(new URL(req.url, issuer), {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: "half",
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(4100);
```

Serve it at `issuer` over https, behind your proxy or a tunnel (`cloudflared tunnel --url http://localhost:4100`), then check it:

```bash
curl https://ps.acme.example/.well-known/aauth-person.json
curl -H "authorization: Bearer $PS_ADMIN_TOKEN" "https://ps.acme.example/consent?status=pending"
```

Each approval is logged as it arrives. Decide one through the management routes (or `ps.decide()` in code), setting a mission's budget as you approve it:

```bash
curl -X POST -H "authorization: Bearer $PS_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"decision": "approve", "budget": {"amount": 300000, "unit": "USD", "decimals": 2}, "decided_by": "dana@acme.example"}' \
  "https://ps.acme.example/consent/<approval id>/decision"
```

An agent that names a `tenant` names it on every request, `/token` included: the tokens it is given carry that tenant, and an auth token request that names a tenant other than its presented token's is refused.

A person's tenant is the directory's: when `directory.person` returns a person with a `tenant`, a request naming another tenant is refused with `403`, and one naming none is given tokens carrying the directory's. A person returned without a `tenant` takes the one the request named, so a directory that serves several tenants checks the `tenant` it is passed and returns `undefined` for someone outside it.

An Introspection connector uses it once its `person_server_url` names `issuer`.

Keep the signing key and subject secret stable: resources cache your keys, and each person's directed `sub` is derived from the secret. The default store is in memory; implement `Store` for anything that must survive a restart. Every `Store` method takes the request's tenant first (the `tenant` the agent named, `undefined` when it named none), and records are kept apart per tenant: a record is found only under the tenant it was saved with. Pass the same tenant to `ps.decide()`, `ps.mission()` and the other lookups, or `?tenant=` to the management routes. `spend` must check and add in one step, and `transitionApproval` must change an approval only from the status it expects, so each decision and each collection happens once.

## Routes

| Route                                               | Who calls it            | What it is                                                |
| --------------------------------------------------- | ----------------------- | --------------------------------------------------------- |
| `GET /.well-known/aauth-person.json`                | agents, resources       | metadata                                                  |
| `GET /.well-known/jwks.json`                        | resources               | the keys person and auth tokens are signed with           |
| `POST {base}/mission`                               | agent                   | propose a mission; `202` while the approver decides       |
| `POST {base}/mission/{s256}`                        | agent                   | `update` a mission's log, or propose its `completion`     |
| `POST {base}/person-token`                          | agent                   | a person token for one resource, under a mission it holds |
| `POST {base}/token`                                 | agent                   | a resource token in, an auth token (or `202`) out         |
| `GET`/`DELETE {base}/pending/{id}`                  | agent                   | poll a decision, or withdraw it; only the key that asked  |
| `GET {base}/consent?status=pending`                 | operator (`adminToken`) | approvals                                                 |
| `POST {base}/consent/{id}/decision`                 | operator (`adminToken`) | `{decision: "approve" \| "deny", budget?, decided_by?}`   |
| `GET {base}/missions`, `GET {base}/missions/{s256}` | operator (`adminToken`) | missions and what each has spent                          |
| `PATCH {base}/missions/{s256}`                      | operator (`adminToken`) | terminate a mission                                       |

`basePath` (`{base}`) defaults to the root. The management routes are off unless `adminToken` is set; the same operations are `ps.approvals()`, `ps.decide()`, `ps.missions()` and `ps.terminate()` in code.

If you are coming from [christian-posta/aauth-person-server](https://github.com/christian-posta/aauth-person-server), the agent routes (`/mission`, `/token`, `/pending/{id}`), the consent routes (`/consent`, `/consent/{id}/decision`) and mission control (`/missions`, `/missions/{s256}`) keep their shape; `-11` adds `/person-token` and `/mission/{s256}`, and a token request is weighed by its resource token's `budget`.

## Policy

Fixed and small:

- a mission is always put to the approver, who may set its budget;
- an auth token needs a live mission covering the resource token's issuer, and only those issuers' keys are fetched;
- a request whose `budget` is in the mission's unit and scale and fits what is left is issued at once and spent; any other budgeted request is put to the approver, and spent when its approved token is collected, so a token is issued only once its spend has landed;
- a request with no `budget` is issued within the mission without spending;
- completing a mission is the person's own decision, and nothing is issued under it afterwards;
- each agent key is bound to the first person it names.
- an approved auth token is collected once: later polls of the same approval answer `410`, so one approval spends once;
- each approval is decided once, however many answers arrive.

## Hooks

`onApproval(approval)` when a decision is needed, `onDecision(approval)` once it is made, and `onIssued({type, agent, person, resource, mission, budget})` for each token issued.
