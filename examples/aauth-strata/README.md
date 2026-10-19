# Alder Court: an AAuth strata demo

**All data is fictional.** The counterpart of [aauth-travel](../aauth-travel), for an owners corporation: the strata recipe's works API is a native AAuth resource, and the owners corporation's Person Server decides who approves what.

| Party                            | Built on                                                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Works API (`lib/works.mjs`)      | [`@introspection-sdk/aauth-resource`](../../packages/introspection-aauth-resource) | Signs quotes. A work order or special levy needs an auth token for exactly that call, its price carried as the resource token's budget: AUD for an order, `AUD-levy` for a levy. Re-checks its own rules (insured contractor, budget line, benefit principle).                                                                                                                                                                          |
| Person Server (`lib/owners.mjs`) | [`@introspection-sdk/person-server`](../../packages/introspection-person-server)   | Speaks for each unit's occupant. A repair (mission) goes to the committee chair, who sets its budget; an order within it issues with no one asked; a levy, in a unit no repair budget carries, becomes an owners' ballot: every lot votes with its own code, decided at close by a majority of votes returned with returns from at least half the lots (Owners Corporations Act 2006 (Vic) s86); the occupant signs off the completion. |
| Agent                            | the platform's egress, or `@aauth/agent` in the e2e                                | Acts for the occupant; holds no credential.                                                                                                                                                                                                                                                                                                                                                                                             |

## Check it with no network

```bash
pnpm install && pnpm --filter @introspection-sdk/aauth-resource build
pnpm --filter introspection-example-aauth-strata e2e
```

Six scenarios run the real AAuth protocol in-process: the chair approves a repair and its budget; an order within it issues unasked; a levy on every lot is refused when only Lots 1–10 benefit; a levy by benefit goes to an owners' ballot and carries; a ballot short of quorum fails; Unit 1 signs off the completion.

## Run it for the strata recipe

```bash
cloudflared tunnel --url http://localhost:4300   # twice: one URL for works, one for the Person Server
WORKS_ISSUER=https://<works> PS_ISSUER=https://<ps> \
TRUSTED_AGENT_PROVIDERS=$(curl -s https://<control plane>/.well-known/aauth-agent.json | jq -r .issuer) \
ADMIN_TOKEN=<secret> node server.mjs
```

Then point the `strata-agm` recipe ([recipe-strata-vendor](https://github.com/introspection-org/recipe-strata-vendor/tree/main/strata-agm)) at it: an `aauth` connector with the works host in `api_hosts` and `person_server_url` set to the Person Server, and `WORKS_API_URL` set to the works issuer.

- The chair's decisions and Unit 1's sign-off: `GET /consent?status=pending` and `POST /consent/<id>/decision` on the Person Server, with `ADMIN_TOKEN`.
- Ballots: `GET /owners/ballots`; each lot votes with `POST /owners/ballots/<id>/votes {lot, code, choice}`, its code printed in the server log as that lot's ballot email; the manager closes with `POST /owners/ballots/<id>/close` and `ADMIN_TOKEN`.

## What's illustrative

- Votes are authenticated by a per-lot code in a printed "email"; a real deployment verifies each owner on its own channel.
- The ballot closes when the manager closes it; a real one closes at its closing date.
- A ballot can outlast a day: the platform's watch on a pending approval is a per-plane setting (`aauth_pending_approval_hours`, 48 by default).
