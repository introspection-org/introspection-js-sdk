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
    "Sam works at Acme, one of Flight Sector's customers, and asks Flight Sector's travel agent for a week in Sydney. The agent holds no credential. The platform is its Agent Provider: it mints an agent token for the session and signs every request the agent makes with the session's key. The booking provider is a native AAuth resource, and Acme runs the Person Server that speaks for Sam. Flight Sector's own rails, Cedar policies shipped in the recipe, run in the platform first. Then it is AAuth's three-party flow: the resource names what it wants in a resource token, the agent takes it to Sam's Person Server, and Acme either issues an auth token, asks Sam's manager, or refuses.",
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
          label: "recipe: search_offers and book_item",
        },
      ],
    },
    {
      id: "agent-token",
      title: "The platform mints an agent token for the session",
      actor: "Agent Provider (control plane)",
      body: "When the session starts, the control plane, acting as Agent Provider, signs an aa-agent+jwt: the agent's identity, the session's public key in cnf.jwk, and in ps the Person Server that speaks for this person, which the connector names. Its keys are published at /.well-known/aauth-agent.json, so any resource can verify it. The private session key stays in the egress proxy, never in the sandbox.",
      sources: [
        {
          kind: "contract",
          path: "agent-token-claims.json",
          label: "the agent token",
        },
      ],
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
      body: "Before anything is signed, the platform runs the recipe's Cedar policies against the request. They are Flight Sector's rules for every customer: never first class, personal legs paid by the traveller, and business class only for travellers at or above their company's seniority threshold on a leg of six hours or more. One rule answers per person: Sam is level 5 and Acme's threshold is 5, so QF74 in business goes on; a level-5 traveller at Globex, whose threshold is 7, gets 403 with the rule's reason, and Globex is never asked. A permit decides nothing: the company's Person Server still does.",
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
      title: "book_item goes out signed, presenting the agent token",
      actor: "Egress → booking provider",
      body: "The agent's book_item is a plain POST. The egress proxy signs it with RFC 9421 HTTP Message Signatures, covering the method, authority, path and content-digest, and puts the agent token in Signature-Key. The provider verifies the signature, verifies the agent token against the Agent Provider's published keys, and checks the token's cnf key is the key that signed.",
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
      title: "401: the provider asks for an auth token, and says for what",
      actor: "Booking provider → egress",
      body: "An agent token says who the agent is, not what it may do. So the provider answers 401 with AAuth-Requirement: requirement=auth-token and a resource token: the provider, the agent's key thumbprint, the agent token it saw, the scope booking.reserve, and the exact quote, purpose and payer. Its audience is the Person Server the agent token named.",
      sources: [
        {
          kind: "example",
          path: "lib/booking.ts",
          region: "challenge",
          label: "the resource token",
        },
        {
          kind: "contract",
          path: "resource-token-claims.json",
          label: "its claims",
        },
      ],
      lights: { type: "booking.challenged" },
    },
    {
      id: "exchange",
      title: "Egress takes the resource token to Acme",
      actor: "Egress → Acme's Person Server",
      body: "The egress proxy holds the request and calls Acme's token endpoint directly, signed with the same key: the resource token, the agent token it presented, and a login hint naming Sam. Acme checks the signature, that the agent token comes from an Agent Provider it trusts, that the resource token comes from a resource it trusts and is addressed to Acme, and that both tokens name the same agent key.",
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
          label: "Acme: verify the request, apply policy",
        },
      ],
      lights: { type: "acme.policy_checked" },
    },
    {
      id: "booked",
      title: "Within policy: 200, an auth token, and the flight is booked",
      actor: "Acme → egress → provider",
      body: "The fare is under Acme's flight cap for Sydney, so Acme answers 200 with an aa-auth+jwt: Sam under a pseudonym only this provider sees, bound to the agent's key, carrying the provider's authorization details unchanged. Egress caches it and replays the held request presenting it. The provider books only the quote the token names, so the token cannot buy anything else.",
      sources: [
        {
          kind: "example",
          path: "lib/acme/person-server.ts",
          region: "policy",
          label: "Acme's policy",
        },
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
      title: "The QT is over the Sydney cap: 202, and Acme emails Dana",
      actor: "Acme → egress → Agent",
      body: "$420 a night against a $300 cap. Acme doesn't refuse: it looks up Sam's manager in its own directory, emails Dana a link and a six-digit code, and answers 202 with a Location to poll. Egress can't hold a chat open for a person, so it answers the agent 428 approval-pending and hands the pending URL to the platform. The agent tells Sam it's waiting on Dana.",
      sources: [
        {
          kind: "example",
          path: "lib/acme/person-server.ts",
          region: "ask",
          label: "Acme: find the manager, email a code",
        },
        {
          kind: "example",
          path: "lib/acme/mail.ts",
          region: "email",
          label: "Acme: the email",
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
      id: "approve",
      title: "Dana approves with the code",
      actor: "Approver → Acme's Person Server",
      body: "Dana opens Acme's page from the email, sees the signed quote and why it needs approval, and enters the code. The code proves the person approving reads Dana's inbox. Acme issues the auth token for exactly this quote. Had Dana declined, the pending URL would answer 403 and the agent would offer something within policy.",
      sources: [
        {
          kind: "example",
          path: "lib/acme/person-server.ts",
          region: "decide",
          label: "Acme: check the code, issue the token",
        },
      ],
      lights: { type: "acme.decided", where: { status: "approved" } },
    },
    {
      id: "resume",
      title: "The chat picks up, and the QT is booked",
      actor: "Platform → Agent → provider",
      body: "The data plane has been polling the pending URL, signed with the session key; only the agent that asked may read it. The poll returns the auth token, egress caches it, and the platform posts a turn into Sam's conversation. The agent books the QT again, egress presents the token, and the provider books exactly the quote Dana approved.",
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
  ],
};
