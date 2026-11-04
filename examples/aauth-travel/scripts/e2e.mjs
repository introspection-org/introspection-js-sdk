// `pnpm e2e`: the whole AAuth flow with no Introspection backend. This script
// plays the agent with the official agent library (@aauth/agent), as the
// platform's egress does for a sandboxed agent, from a test Agent Provider of
// its own. The app supplies the other parties: Flight Sector's booking
// provider and Acme's Person Server. It checks the protocol between them, not
// an agent: no model, recipe or Cedar rails run here.
//
// Every party is named by an https URL with no port, so the script gives each
// a portless name (`https://<name>.localhost` on :443, its local CA trusted
// through NODE_EXTRA_CA_CERTS), starts the app with those URLs, runs the
// scenarios and stops it all. The proxy binds :443, so start it once with
// `sudo npx -y portless@0.15.11 proxy start`. E2E_TUNNEL=cloudflare gives each
// party a free Cloudflare quick tunnel instead (`brew install cloudflared`). Approvals read the
// code from the app's log, where Acme prints its email when RESEND_API_KEY is
// unset.
//
// With E2E_SERVER_LOG set it uses an app you started instead, at the parties'
// URLs in the environment. With PERSON_SERVER=hosted it plays the agent
// against Introspection's hosted Person Server (HOSTED_PERSON_SERVER_URL,
// tenant E2E_TENANT), which must trust the provider.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAAuthFetch,
  createSignedFetch,
  pollDeferred,
} from "@aauth/agent";
import { SignJWT, exportJWK, generateKeyPair, importJWK } from "jose";

const APP_PORT = Number(process.env.E2E_APP_PORT ?? 3400);
const AP_PORT = Number(process.env.E2E_AP_PORT ?? 3499);
const TUNNELS = process.env.E2E_TUNNEL ?? "portless";
const PORTLESS = "portless@0.15.11";
const PORTLESS_CA = join(homedir(), ".portless", "ca.pem");

// Node reads NODE_EXTRA_CA_CERTS only at startup, so the run starts over once
// with portless's CA trusted; the app it spawns inherits it.
if (
  !process.env.E2E_SERVER_LOG &&
  TUNNELS === "portless" &&
  !process.env.NODE_EXTRA_CA_CERTS
) {
  if (!existsSync(PORTLESS_CA)) {
    console.error(
      `No portless CA at ${PORTLESS_CA}: start the proxy once with \`sudo npx -y ${PORTLESS} proxy start\`.`,
    );
    process.exit(1);
  }
  const { status } = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: PORTLESS_CA },
  });
  process.exit(status ?? 1);
}

const children = [];
const stop = () => children.forEach((child) => child.kill());
process.on("exit", stop);

/** A quick tunnel to `port`; resolves with its https URL. */
function tunnel(port) {
  const child = spawn(
    "cloudflared",
    ["tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  children.push(child);
  return new Promise((resolve, reject) => {
    child.on("error", () =>
      reject(new Error("install cloudflared first: brew install cloudflared")),
    );
    child.stderr.on("data", (chunk) => {
      const url = String(chunk).match(
        /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
      )?.[0];
      if (url) resolve(url);
    });
  });
}

/** A portless name routed to `port`; returns its https URL, with no port. */
function portlessRoute(name, port) {
  const alias = spawnSync(
    "npx",
    ["-y", PORTLESS, "alias", name, String(port), "--force"],
    { encoding: "utf8" },
  );
  if (alias.status !== 0) {
    throw new Error(
      `portless alias ${name} failed: ${(alias.stderr || alias.stdout).trim()}`,
    );
  }
  const url = spawnSync("npx", ["-y", PORTLESS, "get", name], {
    encoding: "utf8",
  });
  const origin = url.stdout.trim().split("\n").pop();
  if (url.status !== 0 || !origin?.startsWith("https://")) {
    throw new Error(
      `portless get ${name} gave no https URL; start the proxy: sudo npx -y ${PORTLESS} proxy start`,
    );
  }
  // @aauth/resource rejects an issuer with a port.
  if (new URL(origin).port) {
    throw new Error(
      `portless serves ${origin}, but AAuth needs :443: sudo npx -y ${PORTLESS} proxy stop, then sudo npx -y ${PORTLESS} proxy start`,
    );
  }
  return origin;
}

/** Wait until `url` answers, through a tunnel that may still be propagating. */
async function reachable(url) {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${url} did not answer`);
}

if (!process.env.E2E_SERVER_LOG) {
  const [booking, acme, provider] =
    TUNNELS === "cloudflare"
      ? await Promise.all([tunnel(APP_PORT), tunnel(APP_PORT), tunnel(AP_PORT)])
      : [
          portlessRoute("booking.flightsector", APP_PORT),
          portlessRoute("ps.acme", APP_PORT),
          portlessRoute("e2e-agents", AP_PORT),
        ];
  const log = join(tmpdir(), `aauth-travel-e2e-${process.pid}.log`);
  writeFileSync(log, "");
  Object.assign(process.env, {
    BOOKING_ISSUER: booking,
    ACME_PERSON_SERVER_URL: acme,
    E2E_AGENT_PROVIDER: provider,
    E2E_SERVER_LOG: log,
  });
  const app = spawn(
    "node_modules/.bin/next",
    ["dev", "--turbopack", "--port", String(APP_PORT)],
    {
      env: {
        ...process.env,
        APP_URL: `http://localhost:${APP_PORT}`,
        PERSON_SERVER: "acme",
        TRUSTED_AGENT_PROVIDERS: provider,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(app);
  const append = (chunk) => writeFileSync(log, chunk, { flag: "a" });
  app.stdout.on("data", append);
  app.stderr.on("data", append);
  console.log(`booking ${booking}\nacme    ${acme}\nagents  ${provider}\n`);
  await reachable(`http://localhost:${APP_PORT}/`);
  await reachable(`${booking}/.well-known/aauth-resource.json`);
  await reachable(`${acme}/.well-known/aauth-person.json`);
}

const BOOKING =
  process.env.BOOKING_ISSUER ?? "https://booking.flightsector.localhost";
const ACME = process.env.ACME_PERSON_SERVER_URL ?? "https://ps.acme.localhost";
const HOSTED = process.env.PERSON_SERVER === "hosted";
const PS = HOSTED
  ? (process.env.HOSTED_PERSON_SERVER_URL ??
    "https://ps.introspection.localhost")
  : ACME;
const TENANT = HOSTED ? process.env.E2E_TENANT : undefined;
const SAM_HINT = HOSTED ? "user:sam@acme.example" : "slack:T0ACME/U0SAM";
const AP = process.env.E2E_AGENT_PROVIDER ?? "https://e2e-agents.localhost";
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

// The test agent provider, served on :3499 behind its tunnel.
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
    sub: `aauth:travel@${new URL(AP).hostname}`,
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
async function approving(act, verdict = "approve", budget) {
  check(LOG, "set E2E_SERVER_LOG to the dev server's log file");
  const offset = readFileSync(LOG, "utf8").length;
  const pending = act();
  let email = "";
  for (let i = 0; i < 80 && !/Your code: \d{6}/.test(email); i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    email = readFileSync(LOG, "utf8").slice(offset);
  }
  const code = email.match(/Your code: (\d{6})/)?.[1];
  const id = email
    .match(/Review it here: (\S+)/)?.[1]
    ?.split("/")
    .pop();
  check(code && id, "the approval email is in the server log");
  const decided = await fetch(`${ACME}/ps/approvals/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, verdict, ...(budget ? { budget } : {}) }),
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
    loginHint: SAM_HINT,
    ...(TENANT ? { tenant: TENANT } : {}),
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

const metadata = await (
  await fetch(`${PS}/.well-known/aauth-person.json`)
).json();
const MISSIONS = metadata.mission_endpoint;
const PERSON_TOKENS = metadata.person_token_endpoint;
const asSam = (body) => ({
  ...body,
  login_hint: SAM_HINT,
  ...(TENANT ? { tenant: TENANT } : {}),
});

const agent = await newAgent();
let mission;

await scenario(
  "Dana approves Sam's trip once, and sets its budget",
  async () => {
    const response = await approving(
      () =>
        missionCall(
          agent,
          MISSIONS,
          asSam({ description: TRIP, resources: [BOOKING] }),
        ),
      "approve",
      3000,
    );
    check(response.ok, `mission answered ${response.status}`);
    mission = await response.json();
    const bytes = Buffer.from(mission.mission, "base64url");
    check(
      createHash("sha256").update(bytes).digest("base64url") === mission.s256,
      "s256 is the blob's hash",
    );
    const blob = JSON.parse(bytes);
    check(
      (blob.budget_cents ?? blob.budget?.amount) === 300000,
      "the blob carries the $3,000 Dana set",
    );
    check(
      mission.person_tokens?.[BOOKING],
      "a person token for the booking provider came with it",
    );
  },
);

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
  check(
    /only under an approved trip|only within a mission/.test(refused),
    `reserve ${refused}`,
  );
});

await scenario(
  "Sam accepts the trip as done, and the mission ends",
  async () => {
    const done = await approving(() =>
      missionCall(agent, `${MISSIONS}/${mission.s256}`, {
        action: "completion",
        summary: "Booked QF1 and the QT.",
        ...(TENANT ? { tenant: TENANT } : {}),
      }),
    );
    check(done.ok, `completion answered ${done.status}`);
    const again = await agent.ps(PERSON_TOKENS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        asSam({ resource: BOOKING, mission_s256: mission.s256 }),
      ),
    });
    check(
      again.status === 403,
      `a person token under the ended mission answered ${again.status}`,
    );
  },
);

ap.close();
stop();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
