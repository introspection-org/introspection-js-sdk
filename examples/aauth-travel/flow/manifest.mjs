// The walkthrough, step by step. The page and WALKTHROUGH.md are both
// generated from this file, and every source pane reads the real file it
// names, so the explanation cannot drift from the code.
//
// Source kinds:
//   example  - a file in this example; `region` cuts a `#region name` block
//   recipe   - the vendored public recipe (recipe/)
//   contract - a platform wire shape (flow/contracts/), shown as data

/** @typedef {{ kind: "example", path: string, region?: string, label?: string }} ExampleSource */
/** @typedef {{ kind: "recipe", path: string, label?: string }} RecipeSource */
/** @typedef {{ kind: "contract", path: string, label?: string }} ContractSource */
/** @typedef {ExampleSource | RecipeSource | ContractSource} Source */
/** @typedef {{ type: string, where?: Record<string, string | boolean> }} Lights */
/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   actor: string,
 *   body: string,
 *   sources: Source[],
 *   lights?: Lights,
 * }} Step
 */

/** @type {{ title: string, intro: string, steps: Step[] }} */
export const flow = {
  title: "Flight Sector: company travel over AAuth",
  intro:
    "Sam works at Acme, one of Flight Sector's customers, and asks Flight Sector's travel agent for a week in Sydney. The agent holds no credential. The platform is its Agent Provider: it mints an agent token for the session and signs every request the agent makes with the session's key. The trip is an AAuth mission: Acme's Person Server, which speaks for Sam, has Sam's manager approve it once, budget and all. The booking provider is a native AAuth resource. Flight Sector's own rails, Cedar policies shipped in the recipe, run in the platform first. Then each booking is AAuth's three-party flow: the resource names it in a proposal only Acme can read, and Acme issues an auth token within the trip's budget, asks the manager again, or refuses.",
  steps: [
    {
      id: "ask",
      title: "Sam asks for a trip",
      actor: "Employee → Agent",
      body: "“I need to travel to Sydney from SF next week, arriving for Monday the 19th. I prefer direct flights and the QT.” The agent plans with ordinary tools. Nothing in the recipe knows about AAuth; it makes plain HTTPS calls.",
      sources: [
        { kind: "recipe", path: "SYSTEM.md", label: "recipe: SYSTEM.md" },
        {
          kind: "recipe",
          path: "extensions/booking.js",
          label: "recipe: the trip and booking tools",
        },
      ],
    },
    {
      id: "agent-token",
      title: "The platform mints an agent token for the session",
      actor: "Agent Provider (control plane)",
      body: "When the session starts, the control plane, acting as Agent Provider, signs an aa-agent+jwt: the agent's identity, the session's Ed25519 public key in cnf.jwk, and in ps the Person Server that speaks for this person, which the connector names. Its keys are published at /.well-known/aauth-agent.json, so any resource can verify it. The private session key stays in the egress proxy, never in the sandbox.",
      sources: [
        {
          kind: "contract",
          path: "agent-token-claims.json",
          label: "the agent token",
        },
      ],
    },
    {
      id: "mission",
      title: "The agent proposes the trip, and Acme asks Dana once",
      actor: "Agent → egress → Acme's Person Server",
      body: "Before booking anything, propose_trip posts the trip to person-server.aauth, a name only the egress answers. Egress adds the booking provider and Sam, signs as the agent, and posts it to Acme's mission endpoint. Acme reads the budget from the description and emails Sam's manager, Dana, a link and a six-digit code, answering 202 while she decides.",
      sources: [
        {
          kind: "contract",
          path: "mission-proposal.json",
          label: "the proposal, and what comes back",
        },
        {
          kind: "example",
          path: "lib/acme/person-server.ts",
          region: "missions",
          label: "Acme: missions",
        },
        {
          kind: "example",
          path: "lib/acme/mail.ts",
          region: "email",
          label: "Acme: the email",
        },
      ],
      lights: { type: "acme.approval_requested" },
    },
    {
      id: "mission-approved",
      title: "Dana approves the trip with the code",
      actor: "Approver → Acme's Person Server",
      body: "Dana opens Acme's page from the email, reads the trip and its budget, and enters the code, which proves the person approving reads Dana's inbox. Acme mints the mission: its bytes, their SHA-256 as s256, and a person token for the booking provider carrying mission_s256. Egress keeps the mission and the person token; the agent gets only the s256.",
      sources: [
        {
          kind: "example",
          path: "lib/acme/person-server.ts",
          region: "decide",
          label: "Acme: check the code",
        },
        {
          kind: "example",
          path: "lib/acme/person-server.ts",
          region: "person-token",
          label: "Acme: person tokens under the mission",
        },
      ],
      lights: { type: "acme.mission_approved" },
    },
    {
      id: "search",
      title: "It searches, and every offer is signed",
      actor: "Agent → booking provider",
      body: "Search is open. The provider signs each offer's facts (price, nights, cabin) as a quote, so whoever approves the booking later reads facts the agent cannot alter.",
      sources: [
        {
          kind: "example",
          path: "lib/booking.ts",
          region: "metadata",
          label: "the provider's metadata",
        },
        {
          kind: "example",
          path: "lib/booking.ts",
          region: "quote",
          label: "provider signs each offer",
        },
      ],
      lights: { type: "booking.searched" },
    },
    {
      id: "rails",
      title: "Flight Sector's rails check the booking first",
      actor: "Platform egress (policy gate)",
      body: "Before anything is signed, the platform runs the recipe's Cedar policies against the request, with the session's approved mission as context. They are Flight Sector's rules for every customer: no booking outside an approved trip, never first class, personal legs paid by the traveller, and business class only for travellers at or above their company's seniority threshold on a leg of six hours or more. A forbid answers 403 with the rule's reason, and Acme is never asked. A permit decides nothing: Acme still does.",
      sources: [
        {
          kind: "recipe",
          path: "policies/travel.cedar",
          label: "recipe: the rules",
        },
        {
          kind: "recipe",
          path: "policies/routes.yaml",
          label: "recipe: how a request becomes a Cedar request",
        },
        {
          kind: "contract",
          path: "policy-denied.json",
          label: "what the gate sees, and the refusal",
        },
      ],
    },
    {
      id: "reserve",
      title: "book_item goes out signed, presenting the person token",
      actor: "Egress → booking provider",
      body: "The agent's book_item is a plain POST. The egress proxy signs it with RFC 9421 HTTP Message Signatures, covering the method, authority, path and content-digest, and puts the mission's person token in Signature-Key. The provider verifies the signature, verifies the token against Acme's published keys, and checks the token's cnf key is the key that signed.",
      sources: [
        {
          kind: "contract",
          path: "reserve-request.json",
          label: "what reaches the provider",
        },
        {
          kind: "example",
          path: "lib/aauth.ts",
          region: "verify-signature",
          label: "verify the HTTP signature",
        },
        {
          kind: "example",
          path: "lib/booking.ts",
          region: "reserve",
          label: "the provider's reserve",
        },
      ],
    },
    {
      id: "challenge",
      title: "401: the provider asks for an auth token, for one proposal",
      actor: "Booking provider → egress",
      body: "A person token says who the agent acts for and under which mission, not what it may buy. So the provider publishes the booking as an R3 proposal (the quote, purpose and payer) and answers 401 with AAuth-Requirement: requirement=auth-token and a resource token naming the proposal by its hash, and carrying the mission's s256 across. Only Acme, signing as itself, can read the proposal.",
      sources: [
        {
          kind: "example",
          path: "lib/booking.ts",
          region: "propose",
          label: "the proposal and resource token",
        },
        {
          kind: "contract",
          path: "resource-token-claims.json",
          label: "its claims",
        },
        {
          kind: "example",
          path: "lib/booking.ts",
          region: "serve-r3",
          label: "the proposal, to Acme alone",
        },
      ],
      lights: { type: "booking.challenged" },
    },
    {
      id: "exchange",
      title: "Egress takes the resource token to Acme",
      actor: "Egress → Acme's Person Server",
      body: "The egress proxy holds the request and calls Acme's token endpoint, signed with the same key: the resource token and the person token it presented. Acme checks the signature and the agent token, that the resource token is addressed to Acme and names the same agent key and mission, then reads the proposal and weighs its quote against what is left of the trip's budget.",
      sources: [
        {
          kind: "contract",
          path: "token-request.json",
          label: "the token request and its answers",
        },
        {
          kind: "example",
          path: "lib/acme/person-server.ts",
          region: "verify-agent",
          label: "Acme: verify the agent",
        },
        {
          kind: "example",
          path: "lib/acme/person-server.ts",
          region: "auth-token",
          label: "Acme: verify the request, weigh the budget",
        },
      ],
    },
    {
      id: "booked",
      title:
        "Within the budget: 200, and the flight is booked with no one asked",
      actor: "Acme → egress → provider",
      body: "QF74 in economy, $1,650 of the trip's $3,000. Acme answers 200 with an aa-auth+jwt: Sam under a pseudonym only this provider sees, bound to the agent's key, naming the proposal by r3_s256. Egress caches it and replays the held request presenting it. The provider books only what the proposal names, so the token cannot buy anything else.",
      sources: [
        {
          kind: "contract",
          path: "auth-token-claims.json",
          label: "the auth token",
        },
      ],
      lights: { type: "booking.reserved", where: { kind: "flight" } },
    },
    {
      id: "escalate",
      title: "The QT is over what is left: 202, and Acme emails Dana",
      actor: "Acme → egress → Agent",
      body: "Four nights at $420 is $1,680, and $1,350 is left. Acme doesn't refuse: it emails Dana again and answers 202 with a Location to poll. Egress can't hold a chat open for a person, so it answers the agent 428 approval-pending and hands the pending URL to the platform. The agent tells Sam it's waiting on Dana.",
      sources: [
        {
          kind: "example",
          path: "lib/acme/person-server.ts",
          region: "ask",
          label: "Acme: find the approver, email a code",
        },
        {
          kind: "contract",
          path: "approval-pending.json",
          label: "202 from Acme, 428 to the agent",
        },
      ],
      lights: { type: "acme.approval_requested" },
    },
    {
      id: "resume",
      title: "Dana approves, the chat picks up, and the QT is booked",
      actor: "Platform → Agent → provider",
      body: "The data plane has been polling the pending URL, signed with the session key; only the agent that asked may read it. Once Dana enters the code, the poll returns the auth token, egress caches it, and the platform posts a turn into Sam's conversation. The agent books the QT again, egress presents the token, and the provider books exactly the proposal Dana approved. Had Dana declined, the pending URL would answer 403 and the agent would offer something within budget.",
      sources: [
        {
          kind: "example",
          path: "lib/acme/person-server.ts",
          region: "pending",
          label: "Acme: the pending URL",
        },
        {
          kind: "contract",
          path: "interrupt-resume.json",
          label: "the poll and the turn that resumes the chat",
        },
      ],
      lights: {
        type: "booking.reserved",
        where: { kind: "hotel", payer: "company" },
      },
    },
    {
      id: "complete",
      title: "The trip is booked, and the mission ends",
      actor: "Agent → Acme → Sam",
      body: "complete_trip proposes the mission complete, with a summary of what was booked. Sam accepts it, and Acme ends the mission: a person token or auth token under it is refused from then on, so nothing more can be booked against this trip.",
      sources: [
        {
          kind: "example",
          path: "lib/acme/person-server.ts",
          region: "missions",
          label: "Acme: missions",
        },
      ],
      lights: { type: "acme.mission_completed" },
    },
  ],
};
