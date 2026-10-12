// Drives the demo as Sam would on the page: ask, sign in at Flight Sector,
// pick a flight, disconnect. Needs `pnpm dev` running behind portless.
//
//   pnpm e2e
import assert from "node:assert/strict";

const ATLAS = process.env.ATLAS_URL ?? "https://atlas.localhost";

async function act(action, option) {
  const response = await fetch(`${ATLAS}/api/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, option }),
  });
  const state = await response.json();
  assert.equal(state.error, undefined, `${action}: ${state.error}`);
  return state;
}

function step(name, state) {
  const last = state.chat.at(-1);
  console.log(`✓ ${name}: ${last?.text ?? ""}`);
}

await act("reset");

// Flight Sector refuses a conversation without a DPoP-bound Session Token.
const bare = await fetch("https://pap.flightsector.localhost/poppy/conversations", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ message: { id: "msg_x", sender: "agent", text: "hi" } }),
});
assert.equal(bare.status, 401);
assert.match(bare.headers.get("www-authenticate"), /invalid_token/);
console.log("✓ no token, no conversation");

let state = await act("ask");
assert.equal(state.step, "sign-in");
const signIn = state.chat.at(-1).signIn;
assert.ok(signIn, "Atlas offers a sign-in link");
assert.ok(
  state.seen.some((s) => s.note?.startsWith("authorization: sign_in_required")),
  "Flight Sector asks for sign-in in the conversation",
);
step("ask", state);

// Sam approves both scopes on Flight Sector's consent page.
const consent = await fetch(signIn);
assert.equal(consent.status, 200, "the consent page renders");
const form = new FormData();
form.set("query", new URL(signIn).searchParams.toString());
form.set("decision", "approve");
form.append("scope", "poppy:read");
form.append("scope", "poppy:write");
const decided = await fetch(new URL("/oauth/authorize/decision", signIn), {
  method: "POST",
  body: form,
  redirect: "manual",
});
assert.equal(decided.status, 303);
const callback = decided.headers.get("location");
assert.ok(callback.startsWith(`${ATLAS}/oauth/callback?`), callback);
assert.ok(new URL(callback).searchParams.get("code"), "Flight Sector sends a code back");
const back = await fetch(callback, { redirect: "manual" });
assert.equal(back.status, 303);

state = await (await fetch(`${ATLAS}/api/state`)).json();
assert.equal(state.error, undefined, state.error);
assert.equal(state.step, "choose");
step("sign in", state);

state = await act("choose", "UA863");
assert.equal(state.step, "done");
assert.equal(state.result.flight, "UA863");
assert.equal(state.result.conversation, "closed");
step("choose", state);

state = await act("disconnect");
assert.equal(state.step, "disconnected");
step("disconnect", state);

console.log(`\n${state.exchanges.length} requests:`);
for (const exchange of state.exchanges)
  console.log(`  ${exchange.label}: ${exchange.response.split("\n")[0]}`);
