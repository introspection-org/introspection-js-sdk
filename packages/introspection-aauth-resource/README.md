# @introspection-sdk/aauth-resource

Make an HTTP API a native AAuth resource ([draft-hardt-oauth-aauth-protocol](https://github.com/dickhardt/AAuth) `-11`, three-party): the resource side of what [`@introspection-sdk/person-server`](../introspection-person-server) is to the person's side. Handlers take a Web `Request` and return a `Response`.

- **Discovery:** `/.well-known/aauth-resource.json` and its JWKS.
- **Signed facts:** `sign()` a quote or an offer, `verifySigned()` it when it comes back, so the price a Person Server weighs is the resource's, not the agent's.
- **One call to admit an operation:** `authorize()` verifies the request's RFC 9421 signature and the token it presents, asks for a person token, then answers `401` with a resource token for exactly this call (an R3 proposal of its parameters, readable only by the person's Person Server, and its price as a budget), and admits it once an auth token for that proposal comes back.
- **R3:** serves each proposal to the Person Server it was published for and no one else.

Policy is not the resource's job: who approves, and within what budget, is the Person Server's.

## Use

```ts
import {
  createAAuthResource,
  respond,
} from "@introspection-sdk/aauth-resource";

const resource = await createAAuthResource({
  issuer: "https://works.example", // https://host
  name: "Works API",
  scopes: { "works.order": "Issue a work order on a quote" },
  budgetUnits: [{ unit: "AUD", decimals: 2 }],
  personServers: ["https://ps.example"], // closed list: verifying fetches their keys
  agentProviders: ["https://api.introspection.dev"],
  signingKey: process.env.WORKS_SIGNING_KEY, // PKCS#8 Ed25519 PEM; a fresh key otherwise
});

export async function handle(request: Request): Promise<Response> {
  const served = await resource.handle(request); // well-known documents and R3 proposals
  if (served) return served;
  return respond(async () => {
    const body = await request.text();
    const { quote_id, quote } = JSON.parse(body);
    const facts = await resource.verifySigned(quote); // 400 unless this resource signed it
    const authz = await resource.authorize(request, body, {
      scope: "works.order",
      operation: { action: "order" },
      parameters: { quote_id }, // exactly what the approval binds
      summary: `Order ${quote_id} for $${Number(facts.total_cents) / 100}`,
      budget: { amount: Number(facts.total_cents), unit: "AUD", decimals: 2 },
    });
    if (!authz.ok) return authz.response; // the 401 challenge, or a problem
    return Response.json({
      ordered: quote_id,
      for: authz.sub,
      mission: authz.mission_s256,
    });
  });
}
```

`authz.jti` is the auth token's id: keep it with what the call created to answer a retried call with the same result.

Two resources are built on it:

- [`examples/aauth-travel`](../../examples/aauth-travel)'s booking provider (`lib/booking.ts`), served by Next.js under a rewritten path, so it passes `authorize(…, { url })` and lets its router hand `serveProposal` the key.
- The strata works API in [introspection-org/recipe-strata-vendor](https://github.com/introspection-org/recipe-strata-vendor) (`aauth-strata/`).

## Options worth knowing

- `authorize(request, body, ask, { url })`: `ask` may be a function, run only once the presented token verifies, so a resource challenges before it validates the call. `url` is the public URL the request was addressed to, when the app serves it under another path.
- `onPropose`: called as each call is put to a Person Server, e.g. to log or narrate it.
- `r3Store`: where proposals live until their Person Server reads them; in memory by default, so a multi-process deployment supplies a shared one.
