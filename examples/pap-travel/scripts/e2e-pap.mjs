// `pnpm e2e`: drives the demo as Sam would on the page, through Atlas's API,
// and checks what went over the wire at each step: discovery, the Session
// header, Direct Sign-In, both rebookings (UA863 with no approval, QF8 with
// an operation Sam approves, which is performed once however often the
// approval is sent) and sign-out. Needs `pnpm dev` running behind portless.
import assert from "node:assert/strict";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

const ATLAS = process.env.ATLAS_URL ?? "https://atlas.localhost";
const COMPANY = process.env.COMPANY_URL ?? "https://pap.flightsector.localhost";
const CONVERSATIONS = `${COMPANY}/poppy/conversations`;

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
const exchange = (state, label) => {
  const found = state.exchanges.findLast((x) => x.label === label);
  assert.ok(found, `no request "${label}"`);
  return found;
};
const body = (x) =>
  JSON.parse(x.response.slice(x.response.indexOf("\n\n") + 2));

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

/** Sam asks Atlas, and signs in when Flight Sector needs his booking. */
async function askAndSignIn() {
  await act({ action: "reset" });
  const asked = await act({
    action: "send",
    text: "My QF74 to Sydney is delayed six hours. Can you get me there in time?",
  });
  assert.equal(asked.step, "sign-in");
  return { asked, signedIn: await signIn(asked) };
}

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
  assert.equal(poppy.agent.protocols[0].access, "session");
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
  assert.ok(meta.grant_types_supported.includes("refresh_token"));
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
  "signed out, Atlas talks with the Session header only",
  async () => {
    const run = await askAndSignIn();
    state = run.signedIn;
    const { asked } = run;
    const opened = exchange(asked, "Start a conversation, signed out");
    assert.equal(opened.status, 201);
    assert.match(opened.request, /^Poppy-Session: /m);
    assert.doesNotMatch(opened.request, /^Authorization:/m);
    assert.match(opened.request, /"typ": "poppy-session\+jwt"/);
    assert.doesNotMatch(opened.request, /"ath"/);
    assert.match(
      opened.response,
      /^WWW-Authenticate: Bearer scope="bookings:read bookings:write"/m,
    );
    const events = body(opened).events;
    assert.ok(
      events.some(
        (e) => e.type === "authorization" && e.error === "insufficient_scope",
      ),
      "Flight Sector asks for account access in the conversation",
    );
    assert.ok(
      events.every((e) => e.type !== "message" || e.message.author.type),
      "every message names its author",
    );
  },
);

await check(
  "sign-in is plain OAuth, and signed-in requests carry both",
  async () => {
    assert.equal(state.step, "choose");
    const token = exchange(state, "Finish Direct Sign-In");
    assert.equal(token.status, 200);
    assert.doesNotMatch(token.request, /session_id|Poppy-Session/);
    assert.match(token.request, /grant_type=authorization_code/);
    const tokens = body(token);
    assert.equal(tokens.token_type, "Bearer");
    assert.ok(tokens.refresh_token && tokens.access_token);
    assert.equal(tokens.scope, "bookings:read bookings:write");
    const continued = exchange(state, "Continue the conversation, signed in");
    assert.equal(continued.status, 202);
    assert.match(continued.request, /^Poppy-Session: /m);
    assert.match(continued.request, /^Authorization: Bearer /m);
    assert.match(continued.request, /"ath": "/);
  },
);

await check("UA863: no extra cost, no approval, booked", async () => {
  state = await act({ action: "choose", option: "UA863" });
  assert.equal(state.step, "done");
  assert.equal(state.records.booking.flight, "UA863");
  assert.equal(state.records.changes.length, 1);
  assert.equal(state.records.changes[0].operation_id, undefined);
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
      /^WWW-Authenticate: Bearer scope="bookings:read"$/m,
    );
    assert.equal(state.session.signedIn, false);
  },
);

await check(
  "QF8: Flight Sector asks for approval of the exact terms, and changes nothing",
  async () => {
    ({ signedIn: state } = await askAndSignIn());
    state = await act({ action: "choose", option: "QF8" });
    assert.equal(state.step, "approve");
    const card = state.chat.at(-1).approval;
    assert.ok(card, "Atlas shows Sam the operation");
    const { operation } = card;
    assert.match(operation.operation_id, /^chg_/);
    assert.ok(operation.revision && operation.expires_at && operation.summary);
    assert.equal(operation.terms.fare_difference.amount, "400.00");
    assert.equal(card.mismatch, undefined);
    assert.equal(state.records.changes.length, 0, "nothing is booked yet");
    assert.equal(state.records.booking.flight, "QF74");
  },
);

await check(
  "Sam approves: the approval goes in the conversation, and QF8 is booked",
  async () => {
    state = await act({ action: "approve" });
    assert.equal(state.step, "done");
    const sent = exchange(state, "Send Sam's approval");
    assert.equal(sent.status, 202);
    assert.match(sent.request, /"approval": \{/);
    assert.equal(state.records.booking.flight, "QF8");
    assert.equal(state.records.changes.length, 1);
    assert.match(state.records.changes[0].operation_id, /^chg_/);
  },
);

await check("sending the approval again books nothing more", async () => {
  state = await act({ action: "retry-approval" });
  const first = exchange(state, "Send Sam's approval");
  const same = exchange(state, "Retry the approval: same message");
  assert.equal(same.status, 202);
  assert.deepEqual(
    body(same),
    body(first),
    "a retried message gets its original response",
  );
  const again = exchange(state, "Send the approval again: new message");
  assert.equal(again.status, 202);
  const added = body(again).events;
  assert.ok(
    added.every((e) => e.type !== "message" || e.message.role === "user"),
    "Flight Sector adds nothing to a new message with the same approval",
  );
  assert.equal(state.records.changes.length, 1, "booked once");
  state = await act({ action: "disconnect" });
  assert.equal(state.step, "disconnected");
});

console.log(`\n${passed} checks passed. The last run's requests:`);
for (const x of state.exchanges)
  console.log(`  ${String(x.status).padEnd(4)} ${x.label}`);
