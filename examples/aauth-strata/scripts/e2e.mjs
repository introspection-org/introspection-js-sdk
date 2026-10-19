// `pnpm e2e`: the strata AAuth flow with no network and no Introspection
// backend. ALL DATA IS FICTIONAL. Every party is the real code: the works API
// (@introspection-sdk/aauth-resource), Alder Court's Person Server
// (@introspection-sdk/person-server) and the agent, played by the official
// agent library (@aauth/agent) as the platform's egress does, from a test
// Agent Provider of its own. An in-process fetch stands in for the internet,
// routing each party's https origin to its handler. No model, recipe or Cedar
// rails run here: it checks the protocol and the owners corporation's rules.
import { createHash } from "node:crypto";

import {
  createAAuthFetch,
  createSignedFetch,
  pollDeferred,
} from "@aauth/agent";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

import { createOwners } from "../lib/owners.mjs";
import { createWorks } from "../lib/works.mjs";

const WORKS = "https://works.alder.example";
const PS = "https://ps.alder.example";
const AP = "https://agents.alder.example";
const ADMIN = "e2e-admin-token";

// The test Agent Provider.
const apKeys = await generateKeyPair("Ed25519", { extractable: true });
const apJwk = {
  ...(await exportJWK(apKeys.publicKey)),
  kid: "e2e-ap-1",
  alg: "Ed25519",
};
const agentProvider = (request) => {
  const { pathname } = new URL(request.url);
  if (pathname === "/.well-known/aauth-agent.json")
    return Response.json({
      issuer: AP,
      jwks_uri: `${AP}/jwks.json`,
      name: "e2e test provider",
    });
  if (pathname === "/jwks.json") return Response.json({ keys: [apJwk] });
  return new Response("not found", { status: 404 });
};

const log = [];
const onEvent = (type, data) => log.push({ type, ...data });
const works = await createWorks({
  issuer: WORKS,
  personServers: [PS],
  agentProviders: [AP],
  onEvent,
});
const owners = await createOwners({
  issuer: PS,
  trustedAgentProviders: [AP],
  adminToken: ADMIN,
  retryAfterSeconds: 1,
  onEvent,
});

const parties = {
  [WORKS]: (r) => works.handle(r),
  [PS]: (r) => owners.handle(r),
  [AP]: agentProvider,
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const party = parties[new URL(request.url).origin];
  return party ? party(request) : realFetch(input, init);
};

const results = [];
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
async function scenario(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}
const until = async (condition, what) => {
  for (let i = 0; i < 100; i++) {
    const value = condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** An agent acting for the occupant of Unit 1: a fresh session key and an agent token binding it. */
async function newAgent() {
  const keys = await generateKeyPair("Ed25519", { extractable: true });
  const publicJwk = { ...(await exportJWK(keys.publicKey)), alg: "Ed25519" };
  const signingKey = { ...(await exportJWK(keys.privateKey)), alg: "Ed25519" };
  const iat = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({
    iss: AP,
    dwk: "aauth-agent.json",
    sub: "aauth:strata@agents.alder.example",
    ps: PS,
    jti: crypto.randomUUID(),
    iat,
    exp: iat + 3600,
    cnf: { jwk: publicJwk },
  })
    .setProtectedHeader({ alg: "Ed25519", typ: "aa-agent+jwt", kid: apJwk.kid })
    .sign(apKeys.privateKey);
  const keyMaterial = async () => ({
    signingKey,
    signatureKey: { type: "jwt", jwt },
  });
  return {
    keyMaterial,
    ps: createSignedFetch(keyMaterial, { signBody: true }),
  };
}

const metadata = await (
  await fetch(`${PS}/.well-known/aauth-person.json`)
).json();
const MISSIONS = metadata.mission_endpoint;

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
    maxPollDuration: 30,
  });
  check(!error, `poll failed: ${error?.message}`);
  return done;
}

/** Propose a repair; the chair approves it with `budgetCents`. */
async function approvedRepair(agent, description, budgetCents) {
  const pending = missionCall(agent, MISSIONS, {
    description,
    resources: [WORKS],
    login_hint: "unit:1",
  });
  const approval = await until(
    () => [...owners.waiting.values()].find((a) => a.kind === "mission"),
    "the chair's approval",
  );
  check(
    approval.approver.id === "chair",
    `a repair goes to ${approval.approver.id}, not the chair`,
  );
  await owners.decide(approval.id, {
    status: "approved",
    budget: { amount: budgetCents, unit: "AUD", decimals: 2 },
    decided_by: "chair",
  });
  const response = await pending;
  check(response.ok, `the mission answered ${response.status}`);
  const mission = await response.json();
  check(
    createHash("sha256")
      .update(Buffer.from(mission.mission, "base64url"))
      .digest("base64url") === mission.s256,
    "s256 is the blob's hash",
  );
  return mission;
}

const quoteFor = async (requestId) =>
  (
    await (
      await fetch(`${WORKS}/v1/quotes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId }),
      })
    ).json()
  ).quotes[0];

function callWorks(agent, mission, path, body) {
  const fetchAs = createAAuthFetch({
    getKeyMaterial: agent.keyMaterial,
    personServerUrl: PS,
    loginHint: "unit:1",
    missionS256: mission.s256,
    maxPollDuration: 30,
  });
  return fetchAs(`${WORKS}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Vote the given lots through their own codes, then the manager closes the ballot. */
async function runBallot(votes) {
  const ballot = await until(
    () => [...owners.ballots.values()].find((b) => !b.closed),
    "an owners' ballot",
  );
  for (const [lot, choice] of Object.entries(votes)) {
    const out = owners.vote(
      ballot.id,
      Number(lot),
      ballot.codes.get(Number(lot)),
      choice,
    );
    check(!out.error, out.error);
  }
  check(
    owners.vote(ballot.id, 1, "000000", "for").error,
    "a vote without the lot's code is refused",
  );
  const closed = await realFetchJson(`${PS}/owners/ballots/${ballot.id}/close`);
  return closed;
}
const realFetchJson = async (url) =>
  (
    await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
    })
  ).json();

const agent = await newAgent();
let stackPipe, drain;

await scenario(
  "the chair approves the stack-pipe repair once, and sets its budget",
  async () => {
    stackPipe = await approvedRepair(
      agent,
      "Leaking stack pipe above Unit 7's hallway (WR-2026-0433), up to $2,200.",
      220000,
    );
    const blob = JSON.parse(Buffer.from(stackPipe.mission, "base64url"));
    check(
      (blob.budget?.amount ?? blob.budget_cents) === 220000,
      "the mission carries the $2,200 the chair set",
    );
  },
);

await scenario(
  "within that budget, the work order issues with no one asked",
  async () => {
    const before = owners.waiting.size + owners.ballots.size;
    const response = await callWorks(agent, stackPipe, "/v1/work-orders", {
      quote_id: "Q-9101",
      quote: (await quoteFor("WR-2026-0433")).quote,
    });
    const body = await response.json();
    check(
      response.ok,
      `the order answered ${response.status} ${JSON.stringify(body)}`,
    );
    check(
      String(body.id).startsWith("WO-") && body.mission_s256 === stackPipe.s256,
      "a work order under the repair",
    );
    check(
      owners.waiting.size + owners.ballots.size === before,
      "no one was asked",
    );
  },
);

await scenario(
  "a levy on every lot's liability is refused when only some lots benefit",
  async () => {
    drain = await approvedRepair(
      agent,
      "Collapsed driveway storm-water drain (WR-2026-0435), up to $9,350.",
      935000,
    );
    const response = await callWorks(agent, drain, "/v1/special-levies", {
      quote_id: "Q-9120",
      quote: (await quoteFor("WR-2026-0435")).quote,
      apportion: "lot_liability",
    });
    check(
      response.status === 409,
      `a lot-liability levy answered ${response.status}`,
    );
  },
);

await scenario(
  "a special levy goes to an owners' ballot, and carries with a quorum and a majority",
  async () => {
    const quote = (await quoteFor("WR-2026-0435")).quote;
    const pending = callWorks(agent, drain, "/v1/special-levies", {
      quote_id: "Q-9120",
      quote,
      apportion: "benefit",
    });
    // 12 of 19 lots return a vote; Unit 6 is in arrears, so its vote is not counted.
    const closed = await runBallot({
      1: "for",
      2: "for",
      3: "against",
      4: "for",
      5: "for",
      6: "for",
      7: "for",
      9: "for",
      12: "against",
      15: "for",
      17: "for",
      19: "against",
    });
    check(
      closed.status === "carried" && closed.for === 8 && closed.against === 3,
      `the ballot closed ${JSON.stringify(closed)}`,
    );
    const response = await pending;
    const body = await response.json();
    check(
      response.ok,
      `the levy answered ${response.status} ${JSON.stringify(body)}`,
    );
    check(
      body.shares.length === 10 && body.shares.every((s) => s.lot <= 10),
      "levied on Lots 1-10 by benefit",
    );
  },
);

await scenario(
  "a levy without a quorum fails, however the returned votes fall",
  async () => {
    const quote = (await quoteFor("WR-2026-0435")).quote;
    const pending = callWorks(agent, drain, "/v1/special-levies", {
      quote_id: "Q-9120",
      quote,
      apportion: "benefit",
    });
    const closed = await runBallot({
      1: "for",
      2: "for",
      3: "for",
      4: "for",
      5: "for",
      7: "for",
    });
    check(
      closed.status === "failed_no_quorum",
      `the ballot closed ${closed.status}`,
    );
    const outcome = await pending.then(
      (r) => `answered ${r.status}`,
      (err) => err.message,
    );
    check(
      !/answered 200/.test(outcome),
      `a levy the owners did not pass ${outcome}`,
    );
  },
);

await scenario(
  "Unit 1 signs off the completed repair, and the mission ends",
  async () => {
    const pending = missionCall(agent, `${MISSIONS}/${stackPipe.s256}`, {
      action: "completion",
      summary:
        "Stack pipe joint replaced and pressure-tested (Northside Plumbing).",
    });
    const approval = await until(
      () => [...owners.waiting.values()].find((a) => a.kind === "completion"),
      "Unit 1's sign-off",
    );
    check(
      approval.approver.id === "unit-1",
      `a completion goes to ${approval.approver.id}, not Unit 1`,
    );
    await owners.decide(approval.id, {
      status: "approved",
      decided_by: "unit-1",
    });
    const done = await pending;
    check(done.ok, `completion answered ${done.status}`);
  },
);

globalThis.fetch = realFetch;
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
