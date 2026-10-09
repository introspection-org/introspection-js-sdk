// Plays the agent against a running `pnpm dev`, end to end over AAuth -11 with
// a mission, using the official agent library (@aauth/agent). This is what the
// platform's egress does for a sandboxed agent.
//
//   pnpm dev > /tmp/aauth-travel.log 2>&1 &
//   portless alias e2e-agents 3499 --force
//   E2E_SERVER_LOG=/tmp/aauth-travel.log NODE_EXTRA_CA_CERTS=~/.portless/ca.pem \
//     node scripts/e2e-aauth.mjs
//
// The dev server must trust this script's agent provider:
// TRUSTED_AGENT_PROVIDERS=https://cp.introspection.localhost,https://e2e-agents.localhost
// Approvals read the code from the server log, where Acme prints its email
// when RESEND_API_KEY is unset.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAAuthFetch,
  createSignedFetch,
  pollDeferred,
} from "@aauth/agent";
import { SignJWT, exportJWK, generateKeyPair, importJWK } from "jose";

const BOOKING =
  process.env.BOOKING_ISSUER ?? "https://booking.flightsector.localhost";
const PS = process.env.ACME_PERSON_SERVER_URL ?? "https://ps.acme.localhost";
const AP = process.env.E2E_AGENT_PROVIDER ?? "https://e2e-agents.localhost";
const AP_PORT = 3499;
const SAM = "slack:T0ACME/U0SAM";
const LOG = process.env.E2E_SERVER_LOG;
const TRIP =
  "# Sam's week in Sydney\n\nFlights and a hotel for Sam, 19 to 23 October, up to $3,000.";

const results = [];
function check(condition, message) {
  if (!condition) throw new Error(message);
}
async function scenario(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

// The test agent provider, served on :3499 behind portless.
// Its key is kept across runs: verifiers cache an issuer's keys.
const AP_KEY_FILE = join(tmpdir(), "aauth-travel-e2e-agent-provider.json");
const apPrivate = existsSync(AP_KEY_FILE)
  ? JSON.parse(readFileSync(AP_KEY_FILE, "utf8"))
  : {
      ...(await exportJWK(
        (await generateKeyPair("Ed25519", { extractable: true })).privateKey,
      )),
      kid: "e2e-ap-1",
      alg: "Ed25519",
    };
writeFileSync(AP_KEY_FILE, JSON.stringify(apPrivate));
const apKey = await importJWK(apPrivate, "Ed25519");
const { d: _private, ...apJwk } = apPrivate;
const ap = createServer((req, res) => {
  const body =
    req.url === "/.well-known/aauth-agent.json"
      ? { issuer: AP, jwks_uri: `${AP}/jwks.json`, name: "e2e test provider" }
      : req.url === "/jwks.json"
        ? { keys: [apJwk] }
        : null;
  res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body ?? {}));
});
await new Promise((resolve) => ap.listen(AP_PORT, resolve));

/** An agent: a fresh session key and an agent token binding it. */
async function newAgent() {
  const keys = await generateKeyPair("Ed25519", { extractable: true });
  const publicJwk = { ...(await exportJWK(keys.publicKey)), alg: "Ed25519" };
  const signingKey = { ...(await exportJWK(keys.privateKey)), alg: "Ed25519" };
  const iat = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({
    iss: AP,
    dwk: "aauth-agent.json",
    sub: "aauth:travel@e2e-agents.localhost",
    ps: PS,
    jti: crypto.randomUUID(),
    iat,
    exp: iat + 3600,
    cnf: { jwk: publicJwk },
  })
    .setProtectedHeader({ alg: "Ed25519", typ: "aa-agent+jwt", kid: apJwk.kid })
    .sign(apKey);
  const keyMaterial = async () => ({
    signingKey,
    signatureKey: { type: "jwt", jwt },
  });
  return {
    keyMaterial,
    ps: createSignedFetch(keyMaterial, { signBody: true }),
  };
}

/** Run `act` while approving the email it causes; the approver's code is in the server log. */
async function approving(act, verdict = "approve") {
  check(LOG, "set E2E_SERVER_LOG to the dev server's log file");
  const offset = readFileSync(LOG, "utf8").length;
  const pending = act();
  let email = "";
  for (let i = 0; i < 40 && !/Your code: \d{6}/.test(email); i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    email = readFileSync(LOG, "utf8").slice(offset);
  }
  const code = email.match(/Your code: (\d{6})/)?.[1];
  const id = email
    .match(/Review it here: (\S+)/)?.[1]
    ?.split("/")
    .pop();
  check(code && id, "the approval email is in the server log");
  const decided = await fetch(`${PS}/ps/approvals/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, verdict }),
  });
  check(decided.ok, `decision answered ${decided.status}`);
  return pending;
}

/** POST to the mission endpoint, waiting out a 202. */
async function missionCall(agent, url, body) {
  const response = await agent.ps(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status !== 202) return response;
  const { response: done, error } = await pollDeferred({
    signedFetch: agent.ps,
    locationUrl: new URL(response.headers.get("location"), url).toString(),
    maxPollDuration: 60,
  });
  check(!error, `poll failed: ${error?.message}`);
  return done;
}

async function offer(kind, match) {
  const body =
    kind === "hotel"
      ? { kind, city: "SYD", check_in: "2026-10-19", check_out: "2026-10-23" }
      : { kind, from: "SFO", to: "SYD", date: "2026-10-18", cabin: "economy" };
  const response = await fetch(`${BOOKING}/v1/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const { offers } = await response.json();
  return offers.find(match) ?? offers[0];
}

function reserve(agent, missionS256, chosen) {
  const fetchAs = createAAuthFetch({
    getKeyMaterial: agent.keyMaterial,
    personServerUrl: PS,
    loginHint: SAM,
    ...(missionS256 ? { missionS256 } : {}),
    maxPollDuration: 60,
  });
  return fetchAs(`${BOOKING}/v1/reserve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      offer_id: chosen.offer_id,
      quote: chosen.quote,
      purpose: "business",
      payer: "company",
    }),
  });
}

const agent = await newAgent();
let mission;

await scenario("Dana approves Sam's trip once, as a mission", async () => {
  const response = await approving(() =>
    missionCall(agent, `${PS}/ps/mission`, {
      description: TRIP,
      resources: [BOOKING],
      login_hint: SAM,
    }),
  );
  check(response.ok, `mission answered ${response.status}`);
  mission = await response.json();
  const bytes = Buffer.from(mission.mission, "base64url");
  check(
    createHash("sha256").update(bytes).digest("base64url") === mission.s256,
    "s256 is the blob's hash",
  );
  check(
    JSON.parse(bytes).budget_cents === 300000,
    "the blob carries the $3,000 budget",
  );
  check(
    mission.person_tokens?.[BOOKING],
    "a person token for the booking provider came with it",
  );
});

await scenario(
  "within the trip's budget, the flight books with no one asked",
  async () => {
    const response = await reserve(
      agent,
      mission.s256,
      await offer("flight", (o) => o.cabin === "economy"),
    );
    const body = await response.json();
    check(
      response.ok,
      `reserve answered ${response.status} ${JSON.stringify(body)}`,
    );
    check(String(body.confirmation).startsWith("FS-"), "a confirmation");
    check(body.mission_s256 === mission.s256, "booked under the mission");
  },
);

await scenario(
  "over what is left of the budget, Dana is asked again",
  async () => {
    const qt = await offer("hotel", (o) => o.property === "qt-sydney");
    const response = await approving(() => reserve(agent, mission.s256, qt));
    const body = await response.json();
    check(
      response.ok,
      `reserve answered ${response.status} ${JSON.stringify(body)}`,
    );
    check(String(body.confirmation).startsWith("FS-"), "a confirmation");
  },
);

await scenario("outside a mission, Acme books nothing", async () => {
  const refused = await reserve(
    await newAgent(),
    undefined,
    await offer("hotel", (o) => o.property === "harbour-rocks"),
  ).then(
    (response) => `answered ${response.status}`,
    (err) => err.message,
  );
  check(/only under an approved trip/.test(refused), `reserve ${refused}`);
});

await scenario(
  "Sam accepts the trip as done, and the mission ends",
  async () => {
    const done = await approving(() =>
      missionCall(agent, `${PS}/ps/mission/${mission.s256}`, {
        action: "completion",
        summary: "Booked QF1 and the QT.",
      }),
    );
    check(done.ok, `completion answered ${done.status}`);
    const again = await agent.ps(`${PS}/ps/person-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: BOOKING,
        mission_s256: mission.s256,
        login_hint: SAM,
      }),
    });
    check(
      again.status === 403,
      `a person token under the ended mission answered ${again.status}`,
    );
  },
);

ap.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
