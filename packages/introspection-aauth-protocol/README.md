# @introspection-sdk/aauth-protocol

The plumbing the AAuth packages here share ([draft-hardt-oauth-aauth-protocol](https://github.com/dickhardt/AAuth) `-11`), so a resource, a Person Server and an Access Server each depend on it and on nothing else of ours:

| Export                                                                                                                                                                  | What it is                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `AAuthError`, `problem`                                                                                                                                                 | An AAuth error and its `application/problem+json` response                                                                   |
| `InvalidRequest`, `InvalidToken`, `InvalidCode`, `Expired`, `NotFound`, `MissionNotFound`, `MissionTerminated`, `AccessDenied`, `Denied`, `ServerError`, `Unauthorized` | One error class per AAuth code, each an `AAuthError`; `Unauthorized.signature(code, detail)` adds `Signature-Error`          |
| `AAuthServer`                                                                                                                                                           | The base both servers extend: issuer and key, its `/.well-known/` metadata and keys, `route` under a base path, and `handle` |
| `loadSigner`, `Signer`                                                                                                                                                  | The server's Ed25519 signing key: its JWKS, `kid` and signing                                                                |
| `verifySignature`                                                                                                                                                       | A request's RFC 9421 signature, verified as it was addressed                                                                 |
| `pendingResponse`, `requirementName`, `retryAfter`                                                                                                                      | The `202` an agent or Person Server polls, and reading one's `AAuth-Requirement` and `Retry-After`                           |
| `onOrigin`                                                                                                                                                              | Whether a URL is on an issuer's https origin, with no credentials                                                            |
| `readProposalSummary`                                                                                                                                                   | An R3 proposal's summary, fetched signed and checked against its `s256`, traced as `aauth.r3.read`                           |
| `AAuthLogger`                                                                                                                                                           | Where a server writes its decision records: a fixed message and identifier fields, never a token. Unset, nothing is written. |

The primitives come from [`@hellocoop/httpsig`](https://www.npmjs.com/package/@hellocoop/httpsig), [`@aauth/resource`](https://www.npmjs.com/package/@aauth/resource) and [`jose`](https://www.npmjs.com/package/jose); this package is the thin layer over them that the servers would otherwise each carry.

| Package                                                                          | Depends on this for |
| -------------------------------------------------------------------------------- | ------------------- |
| [`@introspection-sdk/aauth-resource`](../introspection-aauth-resource)           | errors              |
| [`@introspection-sdk/aauth-person-server`](../introspection-aauth-person-server) | all of it           |
| [`@introspection-sdk/aauth-access-server`](../introspection-aauth-access-server) | all of it           |

It mirrors the Rust [`aauth-protocol`](https://crates.io/crates/aauth-protocol) crate and the Python `introspection_aauth.protocol` module where they overlap.
