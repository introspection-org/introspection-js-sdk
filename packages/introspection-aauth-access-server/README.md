# @introspection-sdk/aauth-access-server

An AAuth Access Server ([draft-hardt-oauth-aauth-protocol](https://github.com/dickhardt/AAuth) `-11`, four-party): a resource's own policy over the auth tokens issued for it. Handlers take a Web `Request` and return a `Response`.

In three-party AAuth the person's Person Server issues a resource's auth tokens. A resource that wants a say of its own (its customers, its limits, its approvals) runs an Access Server (AS) and names it as the `aud` of its resource tokens. The person's Person Server, having weighed the request against the person's mission, redeems the resource token here; this server verifies it and asks your policy. Both must agree: neither can grant what the other refuses.

- **Discovery:** `/.well-known/aauth-access.json` (`issuer`, `jwks_uri`, `auth_token_endpoint`) and its JWKS.
- **The token endpoint** (#as-token-endpoint): a Person Server's `POST`, signed with its own key (`sig=jwks_uri`, `dwk="aauth-person.json"`), carrying `resource_token`, `agent_token` and `presented_token`. It checks that the request is signed by the Person Server the resource token names as `ps`, that the resource token is for this server (`aud`) and signed by a resource it decides for, that the agent token is from a trusted agent provider and binds the key the resource token names, and that the presented token is the one the resource saw, from that Person Server. Then it asks `policy`.
- **Auth tokens:** `iss` this server, `dwk` `aauth-access.json`, `aud` the resource, `ps` the Person Server, the directed `sub`, `cnf.jwk` the agent's key, and `mission_s256`, `tenant`, `account` and the R3 claims copied from the resource token; for at most an hour, and never past the agent token or the presented token.
- **Waiting:** a policy may wait on an approval, or on the person at an interaction URL. The Person Server is answered `202` with `AAuth-Requirement` and a `Location` it polls with signed `GET`s, and you settle the request with `decide()`.

Pair it with [`@introspection-sdk/aauth-resource`](../introspection-aauth-resource)'s `accessServer` option on the resource side; [`@introspection-sdk/aauth-person-server`](../introspection-aauth-person-server) federates with it on the person's side.

## Use

```ts
import { createAccessServer } from "@introspection-sdk/aauth-access-server";

const as = await createAccessServer({
  issuer: "https://as.works.example", // https://host, no port or path
  resources: ["https://works.example"], // closed: verifying fetches their keys
  personServers: ["https://ps.acme.example"], // who may redeem here
  agentProviders: ["https://api.introspection.dev"],
  signingKey: process.env.AS_SIGNING_KEY, // PKCS#8 Ed25519 PEM; a fresh key otherwise
  policy: ({ ps, tenant, scope, budget, summary }) => {
    if (!customers.has(`${tenant}@${ps}`))
      return { decision: "deny", detail: `${tenant} has no account` };
    if ((budget?.amount ?? 0) > 500_000) return { decision: "approval" };
    return { decision: "allow" };
  },
  onPending: (pending) => notifyOps(pending), // then as.decide(pending.id, …)
});

export default { fetch: (request: Request) => as.handle(request) };

// Settle a request the policy waited on, once:
as.decide(pending.id, { status: "approved", decided_by: "ops@works.example" });
```

The resource names it:

```ts
const resource = await createAAuthResource({
  issuer: "https://works.example",
  accessServer: "https://as.works.example",
  personServers: ["https://ps.acme.example"],
  // …
});
```

## The policy

`policy(request)` is given the request once everything verifies:

| Field          | What it is                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `resource`     | the resource the token would be for                                                                |
| `ps`           | the Person Server that sent it; `sub` is in its namespace                                          |
| `sub`          | the person's directed identifier at the resource                                                   |
| `tenant`       | the person's organisation, when their Person Server names one; `(ps, tenant)` identifies it        |
| `scope`        | what the resource asked for                                                                        |
| `mission_s256` | the mission it is under, when there is one; the mission itself and its budget stay with the person |
| `budget`       | what the call costs, from the resource token                                                       |
| `summary`      | the resource's one-line description, from its R3 proposal, when this server may read it            |
| `agent`        | the agent's `id`, its `provider` and its key's `jkt`                                               |
| `claims`       | every verified claim of the three tokens, for anything else (agent posture, `account`, R3)         |

It answers one of:

- `{ decision: "allow", scope? }`: issue now, for `scope` when given (no broader than asked);
- `{ decision: "deny", detail? }`: `403 denied`, which the Person Server relays to the agent with its reason;
- `{ decision: "approval" }`: `202 requirement=approval` until `decide()`;
- `{ decision: "interaction", url, code }`: `202 requirement=interaction` with them, until `decide()` once the person has been through `url`. The code follows #interaction-code-format (at least 8 Crockford base32 symbols, single use).

## Routes

| Route                                | Who calls it  | What it is                                         |
| ------------------------------------ | ------------- | -------------------------------------------------- |
| `GET /.well-known/aauth-access.json` | Person Server | metadata                                           |
| `GET /.well-known/jwks.json`         | resource, PS  | the keys auth tokens are signed with               |
| `POST {base}/token`                  | Person Server | the three tokens in, an auth token (or `202`) out  |
| `GET {base}/pending/{id}`            | Person Server | poll a decision; only the Person Server that asked |

A pending request answers `202` until decided, `403 denied` once refused, `408 expired` once past `pendingTtlSeconds` or the tokens it was asked with, and its auth token once approved, collected once (`collected`; later polls are `410`).

Pass `logger` for its decision records: `access request decided`, with `resource`, `ps`, `tenant` and `decision`, identifiers only. `AccessServer` extends `AAuthServer` from `@introspection-sdk/aauth-protocol`.

## Not yet

- `requirement=claims` and `clarification`, payment (`402`) and the `revocation_endpoint`.
- Pending requests live in memory, in one process.
- Trust in a Person Server is the `personServers` list; the draft's dynamic trust establishment is not done.
