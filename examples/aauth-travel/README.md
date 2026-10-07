# aauth-travel

The provider side of the **Flight Sector** demo: an employee of Acme asks
Flight Sector's travel agent, in a Slack DM, to book a Sydney trip. Each booking
needs Acme's approval. Within Acme's policy that is immediate; a hotel over the
city's nightly cap waits for the employee's manager, Dana.

This one process plays the two parties Introspection does not:

| Path                                  | Party                | Does                                                                                 |
| ------------------------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| `POST /v1/search`, `POST /v1/reserve` | the booking provider | sells flights and hotels; a reservation needs the booking connection's token         |
| `POST /missions`                      | Acme's Person Server | receives each pending booking mission, applies Acme's caps, and records the decision |
| `GET /approvals`                      | Dana's approval page | approve or decline what is over policy                                               |

The agent is the recipe `introspection-org/recipe-travel-agent`. How the platform
joins them is `introspection-cloud` `docs/design/connectors-aauth-b2b2c.md` §12.2.

## How a booking flows

1. The agent's `book_item` calls `POST /v1/reserve`, declaring the booking's
   mission in an `Introspection-Mission` header. The platform's mission gate
   answers `428` and the token is not injected.
2. The platform opens a mission and POSTs it here, to `/missions`, with a
   single-use capability.
3. Acme's Person Server looks the offer up and checks Acme's caps (SYD $300,
   MEL $250 a night; flights are in policy). Within policy, it approves at once
   by POSTing the decision to the platform's
   `/v1/person-server/missions/{id}/decision`. Over policy, it tells Dana, and
   decides when she does.
4. The platform tells the agent in the DM. It retries `POST /v1/reserve`; the
   gate lets that one request through with the connection's token, and the
   booking lands.

The platform holds no part of Acme's policy or org chart: swapping this Person
Server for Acme's real one changes nothing on the platform.

## Run it

```bash
BOOKING_PROVIDER_TOKEN=demo-booking-token \
INTROSPECTION_CONTROL_PLANE_URL=http://localhost:8000 \
npm start            # http://localhost:3400
npm test
```

On the platform (with `CONNECTORS_ENABLED` and `PERSON_SERVER_ENABLED`), create
the booking connector and its connection:

```jsonc
// POST /v1/connectors
{
  "name": "Booking",
  "provider": "booking",
  "auth_mode": "person_authorized",
  "api_hosts": ["api.booking.example"],
  "person_server_mode": "byo",
  "person_server_url": "https://<this server>/missions"
}
// POST /v1/connectors/{id}/connections
{ "subject_type": "app", "access_token": "demo-booking-token" }
```

and list the booking host in the auth service's `MISSION_GATE_HOSTS`. A local
`person_server_url` on plain http needs the control plane's
`PERSON_SERVER_ALLOW_PRIVATE_URLS=true`.

## What this example leaves out

- **Who approves.** Every over-policy booking goes to one approver
  (`ACME_APPROVER`). A real Person Server would find the traveller's manager.
- **Email.** Dana's notice goes to the console; she decides on `/approvals`.
- **Reading the request body.** The gate lets one request through per approval,
  for the offer id the tool declares; it does not check the body books that offer.
