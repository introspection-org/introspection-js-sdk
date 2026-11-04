// `pnpm e2e`: the Personal Agent Protocol between Atlas and Flight Sector,
// with no Introspection backend. It is a protocol test, not the demo: the
// Company Agent is a stub at the bridge boundary (POPPY_AGENT=stub,
// lib/company/stub-agent.ts) that answers with fixed lines and one
// request_approval, so no model, recipe, mission or Acme runs here. It drives
// Atlas as Sam would on the page and checks each request on the wire:
// discovery, requests refused without a valid Session header, sign-in first
// (`access: signed_in`), a signed-in conversation, the operation Sam approves,
// an approval sent again that adds nothing, and sign-out.
//
// It starts the app itself on :3501, with Atlas and Flight Sector on their
// portless names; the portless proxy must be on :443
// (`sudo npx portless proxy start` once).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

const PORT = Number(process.env.E2E_APP_PORT ?? 3501);
const ATLAS = "https://atlas.localhost";
const COMPANY = "https://pap.flightsector.localhost";
const CONVERSATIONS = `${COMPANY}/poppy/conversations`;
const PORTLESS_CA = join(homedir(), ".portless", "ca.pem");

// Node reads NODE_EXTRA_CA_CERTS only at startup, so the run starts over once
// with portless's CA trusted; the app it spawns inherits it.
if (!process.env.NODE_EXTRA_CA_CERTS) {
  if (!existsSync(PORTLESS_CA)) {
    console.error(
      `No portless CA at ${PORTLESS_CA}: start the proxy once with \`sudo npx portless proxy start\`.`,
    );
    process.exit(1);
  }
  const { status } = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: PORTLESS_CA },
  });
  process.exit(status ?? 1);
}

for (const name of ["atlas", "pap.flightsector"]) {
  const alias = spawnSync(
    "node_modules/.bin/portless",
    ["alias", name, String(PORT), "--force"],
    { encoding: "utf8" },
  );
  if (alias.status !== 0)
    throw new Error(`portless alias ${name}: ${alias.stderr || alias.stdout}`);
}
const app = spawn(
  "node_modules/.bin/next",
  ["dev", "--turbopack", "--port", String(PORT)],
  {
    env: {
      ...process.env,
      POPPY_AGENT: "stub",
      APP_URL: `http://localhost:${PORT}`,
    },
    stdio: ["ignore", "ignore", "inherit"],
  },
);
process.on("exit", () => app.kill());
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${COMPANY}/.well-known/poppy.json`)).ok) break;
  } catch {
    // not up yet
  }
  if (i > 90) throw new Error("the app did not start");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

let passed = 0;
async function check(name, run) {
  await run();
  passed++;
  console.log(`✓ ${name}`);
}

async function act(body) {
  const response = await fetch(`${ATLAS}/api/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const state = await response.json();
  assert.equal(state.error, undefined, `${body.action}: ${state.error}`);
  return state;
}
const current = async () => (await fetch(`${ATLAS}/api/state`)).json();

async function postConversation(headers) {
  const response = await fetch(CONVERSATIONS, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      message: { id: "msg_e2e", author: { type: "agent" }, text: "hi" },
    }),
  });
  return { status: response.status, body: await response.json() };
}

/** Sam signs in at Flight Sector's consent page, allowing both scopes, and his browser goes back to Atlas. */
async function signIn(state) {
  const link = state.chat.at(-1).signIn;
  assert.ok(link, "Atlas offers a sign-in link");
  const consent = await fetch(link);
  assert.equal(consent.status, 200, "the consent page renders");
  const form = new FormData();
  form.set("query", new URL(link).searchParams.toString());
  form.set("decision", "approve");
  form.append("scope", "bookings:read");
  form.append("scope", "bookings:write");
  const decided = await fetch(new URL("/oauth/authorize/decision", link), {
    method: "POST",
    body: form,
    redirect: "manual",
  });
  assert.equal(decided.status, 303);
  const back = new URL(decided.headers.get("location"));
  assert.equal(`${back.origin}${back.pathname}`, `${ATLAS}/oauth/callback`);
  assert.ok(back.searchParams.get("code"), "a code comes back");
  assert.equal(back.searchParams.get("iss"), COMPANY, "with the issuer");
  const callback = await fetch(back, { redirect: "manual" });
  assert.equal(callback.status, 303);
  const after = await current();
  assert.equal(after.error, undefined, after.error);
  return after;
}

/** Sam asks Atlas; Flight Sector works only signed in, so he signs in first. */
async function askAndSignIn(text) {
  await act({ action: "reset" });
  const asked = await act({ action: "send", text });
  assert.equal(asked.step, "sign-in");
  return { asked, signedIn: await signIn(asked) };
}

const companyLines = (state) =>
  state.chat.filter(
    (l) => l.from === "Atlas" && l.text.startsWith("**Flight Sector:**"),
  );
const wire = (state) => state.behind.exchanges;
const exchange = (state, label) => {
  const found = wire(state).findLast((x) => x.label === label);
  assert.ok(found, `no request "${label}"`);
  return found;
};

await check("discovery documents for draft 0.3", async () => {
  const poppy = await (await fetch(`${COMPANY}/.well-known/poppy.json`)).json();
  assert.equal(poppy.protocol_version, "0.3");
  assert.equal(poppy.organization.domain, new URL(COMPANY).hostname);
  assert.deepEqual(Object.keys(poppy.auth.scopes), [
    "bookings:read",
    "bookings:write",
  ]);
  assert.equal(
    poppy.auth.scope_hints["bookings:write"].changes,
    "irreversible",
  );
  assert.equal(poppy.agent.protocols[0].access, "signed_in");
  assert.equal(poppy.extensions.operations.version, "2");
  const resource = await (
    await fetch(`${COMPANY}/.well-known/oauth-protected-resource`)
  ).json();
  assert.equal(resource.resource, COMPANY);
  assert.deepEqual(resource.authorization_servers, [COMPANY]);
  const meta = await (
    await fetch(`${COMPANY}/.well-known/oauth-authorization-server`)
  ).json();
  assert.equal(meta.issuer, COMPANY);
  assert.ok(meta.protected_resources.includes(COMPANY));
  assert.deepEqual(meta.scopes_supported, ["bookings:read", "bookings:write"]);
  const agent = await (await fetch(`${ATLAS}/agent.json`)).json();
  assert.equal(agent.extensions.operations.version, "2");
});

await check("a request without a valid Session header is refused", async () => {
  const missing = await postConversation({});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, "invalid_session");
  const garbage = await postConversation({ "Poppy-Session": "not-a-jwt" });
  assert.equal(garbage.status, 400);
  assert.equal(garbage.body.error, "invalid_session");
  // Atlas's client_id, but a delegation signed by a key not in its jwks_uri.
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const delegation = await new SignJWT({
    cnf: { jwk: await exportJWK(publicKey) },
  })
    .setProtectedHeader({
      alg: "ES256",
      typ: "poppy-delegation+jwt",
      kid: "forged",
    })
    .setIssuer(`${ATLAS}/agent.json`)
    .setIssuedAt()
    .setExpirationTime("1h")
    .setJti("forged-delegation-0000000")
    .sign(privateKey);
  const forged = await new SignJWT({
    sid: "e2e-forged-session-00000",
    htm: "POST",
    htu: CONVERSATIONS,
  })
    .setProtectedHeader({
      typ: "poppy-session+jwt",
      alg: "ES256",
      kid: "x",
      poppy_dlg: delegation,
    })
    .setIssuer(`${ATLAS}/agent.json`)
    .setAudience(COMPANY)
    .setSubject("usr_forged")
    .setIssuedAt()
    .setJti("forged-session-jwt-000000")
    .sign(privateKey);
  const refused = await postConversation({ "Poppy-Session": forged });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "invalid_session");
});

await check("the token endpoint has no signed-out grant", async () => {
  const response = await fetch(`${COMPANY}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      client_id: `${ATLAS}/agent.json`,
    }),
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "invalid_client");
});

let state;
await check(
  "access: signed_in, so Atlas has Sam sign in before it says anything",
  async () => {
    const run = await askAndSignIn(
      "My QF74 is delayed. Get me there in time without paying more.",
    );
    assert.equal(
      wire(run.asked).filter((x) =>
        x.label.startsWith("Start the conversation"),
      ).length,
      0,
      "no conversation before sign-in",
    );
    state = run.signedIn;
    const token = exchange(state, "Finish Direct Sign-In");
    assert.equal(token.status, 200);
    assert.doesNotMatch(token.request, /session_id|Poppy-Session/);
    const tokens = JSON.parse(
      token.response.slice(token.response.indexOf("\n\n") + 2),
    );
    assert.equal(tokens.token_type, "Bearer");
    assert.ok(tokens.refresh_token && tokens.access_token);
  },
);

await check(
  "the signed-in conversation carries the Session header and the access token",
  async () => {
    const opened = exchange(state, "Start the conversation");
    assert.equal(opened.status, 201);
    assert.match(opened.request, /^Poppy-Session: /m);
    assert.match(opened.request, /^Authorization: Bearer /m);
    assert.match(opened.request, /"ath": "/);
    assert.match(opened.request, /"current_booking"/);
    assert.equal(
      companyLines(state).length,
      1,
      "the agent's offer reached Sam",
    );
  },
);

await check("UA863: no extra cost, no operation", async () => {
  state = await act({
    action: "send",
    text: "The one at no extra cost, please.",
  });
  const passed = exchange(state, "Pass on Sam's words");
  assert.match(passed.request, /"type": "human"/);
  assert.match(companyLines(state).at(-1).text, /Booked: UA863/);
  assert.equal(
    state.chat.some((l) => l.approval),
    false,
  );
});

await check(
  "sign-out revokes the refresh token, and the Session carries on signed out",
  async () => {
    state = await act({ action: "disconnect" });
    assert.equal(state.step, "disconnected");
    assert.equal(exchange(state, "Close the conversation").status, 200);
    assert.equal(
      exchange(state, "Sign out: revoke the refresh token").status,
      200,
    );
    const read = exchange(state, "Read the conversation, signed out");
    assert.equal(read.status, 401);
    assert.match(read.request, /^Poppy-Session: /m);
    assert.doesNotMatch(read.request, /^Authorization:/m);
    assert.match(
      read.response,
      /^WWW-Authenticate: Bearer scope="bookings:read bookings:write"$/m,
    );
  },
);

await check(
  "QF8: an operation for the exact terms, shown to Sam, and nothing booked",
  async () => {
    ({ signedIn: state } = await askAndSignIn(
      "My QF74 is delayed. Get me there early, even if it costs more.",
    ));
    state = await act({
      action: "send",
      text: "QF8 via Dallas, even if it costs more.",
    });
    assert.equal(state.step, "approve");
    const { operation } = state.chat.at(-1).approval;
    assert.match(operation.operation_id, /^chg_/);
    assert.ok(operation.revision && operation.expires_at && operation.summary);
    assert.equal(operation.terms.difference, "400.00");
    assert.doesNotMatch(
      companyLines(state)
        .map((l) => l.text)
        .join("\n"),
      /Booked: QF8/,
    );
  },
);

await check(
  "Sam approves: the approval goes in the conversation, and the agent books once",
  async () => {
    state = await act({ action: "approve" });
    const sent = exchange(state, "Send Sam's approval");
    assert.equal(sent.status, 202);
    assert.match(sent.request, /"approval": \{/);
    assert.equal(
      companyLines(state).filter((l) => /Booked: QF8/.test(l.text)).length,
      1,
    );
  },
);

await check("sending the approval again adds nothing", async () => {
  state = await act({ action: "retry-approval" });
  const same = exchange(state, "Retry the approval: same message");
  assert.equal(same.status, 202);
  const again = exchange(state, "Send the approval again: new message");
  assert.equal(again.status, 202);
  const body = JSON.parse(
    again.response.slice(again.response.indexOf("\n\n") + 2),
  );
  assert.ok(
    body.events.every((e) => e.type !== "message" || e.message.role === "user"),
    "Flight Sector adds no reply to a new message with the same approval",
  );
  assert.equal(
    companyLines(state).filter((l) => /Booked: QF8/.test(l.text)).length,
    1,
    "booked once",
  );
  state = await act({ action: "disconnect" });
  assert.equal(state.step, "disconnected");
});

console.log(
  `\n${passed} checks passed. Protocol test only: no Introspection, model or Acme ran.`,
);
process.exit(0);
