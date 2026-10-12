# Flight Sector · PAP travel

A [Personal Agent Protocol](https://personalagentprotocol.org/docs/spec) (draft 0.1) demo. Sam's flight QF74 is delayed six hours. Sam asks Atlas, their own assistant, to get them to Sydney in time. Atlas finds Flight Sector, talks with Flight Sector's agent, has Sam sign in once, and rebooks Sam.

The page shows three things side by side, as PAP's own examples do: Sam's chat with Atlas, what Flight Sector sees of the conversation between the two agents, and every request Atlas makes, with credentials shortened.

It is a companion to [`aauth-travel`](../aauth-travel), which tells a similar story over AAuth, and shares no code with it.

## The flow

| Sam                                       | What happens on the wire                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "My QF74 to Sydney is delayed six hours…" | Atlas fetches Flight Sector's `/.well-known/poppy.json`, checks that its OAuth server lists that domain, and starts a **signed-out Session**: a JWT bearer grant naming Atlas and Sam's User ID for Flight Sector, with a DPoP proof. It opens a **conversation**. Flight Sector's agent needs Sam's booking and answers with an `authorization` event, `sign_in_required`. |
| Signs in at Flight Sector                 | **Direct Sign-In**: Atlas sends Sam to Flight Sector's own page (authorization code, PKCE). Sam allows "See your bookings" and "Change your bookings". Atlas exchanges the code with its `session_id` and gets an Account Token and a signed-in Session Token.                                                                                                              |
| —                                         | Atlas continues the same conversation. Flight Sector's agent finds booking FS-8Q2M and offers UA863 (no extra cost) or QF8 via Dallas ($400 more).                                                                                                                                                                                                                          |
| "UA863, please."                          | Atlas passes the choice on. Flight Sector checks the token's `poppy:write` scope, rebooks, and confirms. Atlas closes the conversation.                                                                                                                                                                                                                                     |
| Disconnect                                | Atlas revokes its Account Token.                                                                                                                                                                                                                                                                                                                                            |

## Run it

Both parties are https hosts: Atlas at `https://atlas.localhost`, Flight Sector at `https://pap.flightsector.localhost` (its domain, OAuth issuer and conversation API). One Next.js process serves both through [portless](https://github.com/vercel-labs/portless).

```bash
pnpm install
pnpm --filter introspection-example-pap-travel dev   # open https://atlas.localhost
```

`pnpm e2e` drives the same story as Sam would on the page, and checks each step.

## What is real, and what is scripted

The protocol is real: discovery and its issuer check, client authentication by Client ID Metadata Document and `private_key_jwt`, Session assertions, DPoP proofs checked for method, URL, token hash and replay, the authorization code flow with PKCE and `session_id`, Account Tokens, scopes enforced on the change, retry-safe message IDs, cursors, and revocation.

The agents are scripted, so the demo runs the same way every time: Sam's lines are buttons, and Flight Sector's agent answers from a fixed booking. Flight Sector keeps everything in memory, and Sam is already signed in to Flight Sector's site.

## Compared with `aauth-travel`

|                     | `pap-travel`                                                   | `aauth-travel`                                                            |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Whose agent         | Sam's own assistant, at Flight Sector                          | Flight Sector's agent, acting for Sam                                     |
| Who vouches for Sam | Atlas names a User ID; Sam signs in to Flight Sector           | Acme's Person Server                                                      |
| Permission          | Sam grants scopes once                                         | Dana approves the trip, with a budget, and each booking over what is left |
| The $400 option     | Books if Sam picks it: the scope covers it                     | Goes back to Dana                                                         |
| Each request        | A DPoP-bound token; the proof covers the method, URL and token | An RFC 9421 signature over the request, body included                     |
| The conversation    | Part of the protocol                                           | The recipe's own Slack channel                                            |
