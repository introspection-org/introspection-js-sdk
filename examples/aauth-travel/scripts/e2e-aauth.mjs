// Plays the agent against a running `pnpm dev`, end to end over AAuth -11's
// three-party flow: a local test agent provider issues agent tokens, the agent
// presents one at the booking provider, and takes each resource token it gets
// back to Acme's Person Server for an auth token. This is what the platform's
// egress does for a sandboxed agent.
//
//   pnpm dev > /tmp/aauth-travel.log 2>&1 &
//   E2E_SERVER_LOG=/tmp/aauth-travel.log node scripts/e2e-aauth.mjs
//
// The approval path reads Dana's code from the server log, where Acme prints
// its email when RESEND_API_KEY is unset.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import {
  calculateThumbprint,
  fetch as signedFetch,
  parseDictionary,
} from "@hellocoop/httpsig";
import {
  SignJWT,
  calculateJwkThumbprint,
  decodeJwt,
  exportJWK,
  generateKeyPair,
} from "jose";

const APP = process.env.APP_URL ?? "http://localhost:3400";
const PS = process.env.ACME_PERSON_SERVER_URL ?? "http://127.0.0.1:3400";
const AP_PORT = 3499;
const AP = `http://localhost:${AP_PORT}`;
const AP_KID = "e2e-ap-1"; // a fresh key each run: verifiers refresh on failure
const SAM = "slack:T0ACME/U0SAM";
const LOG = process.env.E2E_SERVER_LOG;
const CHECK_IN = "2026-10-19";
const CHECK_OUT = "2026-10-23";

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

// The test agent provider: its metadata and keys, served from this script.
const apKeys = await generateKeyPair("ES256", { extractable: true });
const apJwk = {
  ...(await exportJWK(apKeys.publicKey)),
  kid: AP_KID,
  alg: "ES256",
};
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

/** An agent: a fresh signing key and an agent token binding it. */
async function newAgent(alg) {
  const keys = await generateKeyPair(alg, { extractable: true });
  const publicJwk = { ...(await exportJWK(keys.publicKey)), alg };
  const privateJwk = { ...(await exportJWK(keys.privateKey)), alg };
  const iat = Math.floor(Date.now() / 1000);
  const agentToken = await new SignJWT({
    iss: AP,
    dwk: "aauth-agent.json",
    sub: "aauth:e2e-travel-agent@localhost",
    cnf: { jwk: publicJwk },
    ps: PS,
    jti: randomUUID(),
    iat,
    exp: iat + 3600,
  })
    .setProtectedHeader({ alg: "ES256", typ: "aa-agent+jwt", kid: AP_KID })
    .sign(apKeys.privateKey);
  return {
    privateJwk,
    jkt: await calculateJwkThumbprint(publicJwk),
    agentToken,
  };
}

/** A request signed by the agent, presenting `token` in Signature-Key. */
function signed(agent, url, token, body) {
  return signedFetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
    signingKey: agent.privateJwk,
    signatureKey: { type: "jwt", jwt: token },
    contentDigest: body ? "require" : "omit",
  });
}

const json = (response) => response.json().catch(() => ({}));

function requirementOf(response) {
  const header = response.headers.get("aauth-requirement");
  if (!header) return null;
  const [value, params] = parseDictionary(header).get("requirement");
  return {
    requirement: String(value),
    params: Object.fromEntries([...params].map(([k, v]) => [k, String(v)])),
  };
}

async function search(body) {
  const response = await fetch(`${APP}/booking/v1/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  check(response.ok, `search answered ${response.status}`);
  return (await response.json()).offers;
}

const booking = await (
  await fetch(`${APP}/booking/.well-known/aauth-resource.json`)
).json();
const person = await (
  await fetch(`${PS}/.well-known/aauth-person.json`)
).json();
check(person.issuer === PS, `PS metadata names ${person.issuer}`);
check(booking.access_mode === "auth-token", "booking wants an auth token");
const RESERVE = `${booking.issuer}/v1/reserve`;

/** Reserve presenting `presented`; on the challenge, exchange at Acme. */
async function attempt(agent, presented, reservation) {
  const first = await signed(agent, RESERVE, presented, reservation);
  const challenge = requirementOf(first);
  check(
    first.status === 401 && challenge?.requirement === "auth-token",
    `reserve answered ${first.status} ${JSON.stringify(await json(first))}`,
  );
  const resourceToken = challenge.params["resource-token"];
  const rt = decodeJwt(resourceToken);
  check(rt.iss === booking.issuer, "resource token is the provider's");
  check(rt.agent_jkt === agent.jkt, "resource token binds the agent's key");
  check(
    rt.presented_jti === decodeJwt(presented).jti,
    "presented_jti names the token we showed",
  );
  check(rt.aud === PS, "resource token is for Acme's PS");
  return signed(agent, person.auth_token_endpoint, agent.agentToken, {
    resource_token: resourceToken,
    presented_token: presented,
    login_hint: SAM,
  });
}

async function reserveWith(agent, authToken, reservation) {
  const claims = decodeJwt(authToken);
  check(
    claims.cnf.jwk && (await calculateThumbprint(claims.cnf.jwk)) === agent.jkt,
    "auth token binds our key",
  );
  const response = await signed(agent, RESERVE, authToken, reservation);
  const body = await json(response);
  check(
    response.status === 200,
    `retry answered ${response.status} ${JSON.stringify(body)}`,
  );
  check(/^FS-/.test(body.confirmation), "booked");
  return body;
}

/** Wait for Acme's email to Dana in the server log, past `offset`. */
async function danasEmail(offset) {
  let email = "";
  for (let i = 0; i < 20 && !/Your code: \d{6}/.test(email); i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    email = readFileSync(LOG, "utf8").slice(offset);
  }
  const code = email.match(/Your code: (\d{6})/)?.[1];
  const link = email.match(/Review it here: (\S+)/)?.[1];
  check(code && link, "Dana's email is in the server log");
  return { code, id: link.split("/").pop(), link };
}

const decide = (id, code, verdict) =>
  fetch(`${PS}/ps/approvals/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, verdict }),
  });

/** Ask for an over-policy booking; returns the pending URL and Dana's email. */
async function overPolicy(agent, presented, reservation) {
  check(LOG, "set E2E_SERVER_LOG to the dev server's log file");
  const offset = readFileSync(LOG, "utf8").length;
  const exchange = await attempt(agent, presented, reservation);
  check(
    exchange.status === 202,
    `token answered ${exchange.status} ${JSON.stringify(await json(exchange))}`,
  );
  check(
    requirementOf(exchange)?.requirement === "approval",
    "requirement=approval",
  );
  check(exchange.headers.get("retry-after"), "Retry-After is set");
  const pending = new URL(exchange.headers.get("location"), PS).toString();
  return { pending, email: await danasEmail(offset) };
}

const reservationOf = (offer, purpose = "business", payer = "company") => ({
  offer_id: offer.offer_id,
  quote: offer.quote,
  purpose,
  payer,
});

const hotelsIn = (city, check_in, check_out) =>
  search({ kind: "hotel", city, check_in, check_out });

const es256 = await newAgent("ES256");
let flightAuthToken;

await scenario("unsigned reserve: 401 requirement=auth-token", async () => {
  const unsigned = await fetch(RESERVE, { method: "POST", body: "{}" });
  check(unsigned.status === 401, `reserve answered ${unsigned.status}`);
  check(
    requirementOf(unsigned)?.requirement === "auth-token",
    "unsigned -> auth-token",
  );
});

await scenario(
  "in-policy flight: agent token -> 401 resource token -> 200 auth token -> booked",
  async () => {
    const offers = await search({
      kind: "flight",
      from: "SFO",
      to: "SYD",
      date: "2026-10-17",
      cabin: "business",
    });
    const qf74 = offers.find((o) => o.flight === "QF74");
    const reservation = reservationOf(qf74);
    const exchange = await attempt(es256, es256.agentToken, reservation);
    const body = await json(exchange);
    check(
      exchange.status === 200,
      `token answered ${exchange.status} ${JSON.stringify(body)}`,
    );
    flightAuthToken = body.auth_token;
    const claims = decodeJwt(flightAuthToken);
    check(claims.aud === booking.issuer, "auth token is for the provider");
    check(claims.iss === PS, "auth token is Acme's");
    const booked = await reserveWith(es256, flightAuthToken, reservation);
    console.log(`     ${booked.confirmation} ${booked.offer_id}`);
    const again = await signed(es256, RESERVE, flightAuthToken, reservation);
    check(
      (await json(again)).confirmation === booked.confirmation,
      "a replay returns the same booking",
    );
  },
);

await scenario(
  "QT over cap: step-up -> 202 -> Dana approves -> poll -> booked",
  async () => {
    const offers = await hotelsIn("SYD", CHECK_IN, CHECK_OUT);
    const qt = offers.find((o) => o.property === "qt-sydney");
    const reservation = reservationOf(qt);
    // Presenting the flight's auth token: the provider steps up for the QT.
    const { pending, email } = await overPolicy(
      es256,
      flightAuthToken,
      reservation,
    );
    console.log(`     Dana's email: ${email.link} code ${email.code}`);

    const early = await signed(es256, pending, es256.agentToken);
    check(early.status === 202, `first poll answered ${early.status}`);
    const stranger = await newAgent("ES256");
    const theirs = await signed(stranger, pending, stranger.agentToken);
    check(
      theirs.status === 404,
      `another agent's poll answered ${theirs.status}`,
    );

    const wrong = await decide(
      email.id,
      email.code === "000000" ? "111111" : "000000",
      "approve",
    );
    check(wrong.status === 401, `a wrong code answered ${wrong.status}`);
    const approve = await decide(email.id, email.code, "approve");
    check(approve.ok, `approval answered ${approve.status}`);

    const poll = await signed(es256, pending, es256.agentToken);
    const body = await json(poll);
    check(
      poll.status === 200 && body.auth_token,
      `poll answered ${poll.status}`,
    );
    const booked = await reserveWith(es256, body.auth_token, reservation);
    console.log(`     ${booked.confirmation} ${booked.offer_id}`);
  },
);

await scenario("Dana declines: the poll answers 403", async () => {
  const offers = await hotelsIn("SYD", "2026-10-26", "2026-10-28");
  const qt = offers.find((o) => o.property === "qt-sydney");
  const { pending, email } = await overPolicy(
    es256,
    es256.agentToken,
    reservationOf(qt),
  );
  const decline = await decide(email.id, email.code, "decline");
  check(decline.ok, `decline answered ${decline.status}`);
  const poll = await signed(es256, pending, es256.agentToken);
  check(poll.status === 403, `poll answered ${poll.status}`);
});

await scenario(
  "Melbourne weekend paid by Sam: no approval needed",
  async () => {
    const offers = await hotelsIn("MEL", "2026-10-23", "2026-10-25");
    const reservation = reservationOf(offers[0], "personal", "traveler");
    const exchange = await attempt(es256, es256.agentToken, reservation);
    const body = await json(exchange);
    check(exchange.status === 200, `token answered ${exchange.status}`);
    await reserveWith(es256, body.auth_token, reservation);
  },
);

await scenario("Ed25519 agent key: in-policy hotel booked", async () => {
  const ed = await newAgent("Ed25519");
  const offers = await hotelsIn("SYD", CHECK_IN, CHECK_OUT);
  const harbour = offers.find((o) => o.property === "harbour-rocks");
  const reservation = reservationOf(harbour);
  const exchange = await attempt(ed, ed.agentToken, reservation);
  const body = await json(exchange);
  check(
    exchange.status === 200,
    `token answered ${exchange.status} ${JSON.stringify(body)}`,
  );
  await reserveWith(ed, body.auth_token, reservation);
});

await scenario("another agent's auth token is refused", async () => {
  const other = await newAgent("ES256");
  const offers = await hotelsIn("SYD", CHECK_IN, CHECK_OUT);
  const response = await signed(
    other,
    RESERVE,
    flightAuthToken,
    reservationOf(offers[0]),
  );
  check(response.status === 401, `reserve answered ${response.status}`);
  check(
    requirementOf(response)?.requirement !== "auth-token" ||
      !requirementOf(response)?.params["resource-token"],
    "no resource token for a key the token does not bind",
  );
});

ap.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
