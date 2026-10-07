import assert from "node:assert/strict";
import { test } from "node:test";

import { createApp } from "../server.mjs";

function harness() {
  const decisions = [];
  const notices = [];
  const app = createApp({
    token: "provider-token",
    controlPlaneUrl: "http://cp.test",
    notify: (message) => notices.push(message),
    fetchImpl: async (url, init) => {
      decisions.push({
        url,
        authorization: init.headers.authorization,
        body: JSON.parse(init.body),
      });
      return new Response(null, { status: 204 });
    },
  });
  return { app, decisions, notices };
}

function mission(resource, id = "m-1") {
  return {
    mission_id: id,
    action: "hotel.reserve",
    requested_permissions: {
      host: "api.booking.example",
      resource,
      limits: { count: 1 },
    },
    approval_url: `http://consent.test/m/${id}?cap=cap-${id}`,
    capability: `cap-${id}`,
  };
}

test("a reservation needs the connection's token", async () => {
  const { app } = harness();
  const denied = await app.route(
    "POST",
    "/v1/reserve",
    { offer_id: "ht-syd-vibe" },
    {},
  );
  assert.equal(denied.status, 401);
  const booked = await app.route(
    "POST",
    "/v1/reserve",
    { offer_id: "ht-syd-vibe" },
    { authorization: "Bearer provider-token" },
  );
  assert.equal(booked.status, 200);
  assert.match(booked.body.confirmation, /^BK-/);
});

test("a hotel within Acme's cap is approved at once", async () => {
  const { app, decisions, notices } = harness();
  const result = await app.route(
    "POST",
    "/missions",
    mission("ht-syd-vibe"),
    {},
  );
  assert.equal(result.status, 200);
  assert.deepEqual(decisions, [
    {
      url: "http://cp.test/v1/person-server/missions/m-1/decision",
      authorization: "Capability cap-m-1",
      body: {
        verdict: "approved",
        granted_permissions: mission("ht-syd-vibe").requested_permissions,
      },
    },
  ]);
  assert.deepEqual(notices, []);
});

test("a hotel over the cap waits for Dana, who decides on the approvals page", async () => {
  const { app, decisions, notices } = harness();
  const waiting = await app.route(
    "POST",
    "/missions",
    mission("ht-syd-qt"),
    {},
  );
  assert.equal(waiting.status, 202);
  assert.equal(decisions.length, 0);
  assert.match(
    notices[0],
    /QT Sydney at \$420\/night is over Acme's \$300 cap for SYD/,
  );
  assert.match(
    (await app.route("GET", "/approvals", {}, {})).html,
    /QT Sydney/,
  );

  await app.route("POST", "/approvals/m-1/decline", {}, {});
  assert.deepEqual(decisions[0].body, {
    verdict: "denied",
    granted_permissions: {},
  });
  assert.match(
    (await app.route("GET", "/approvals", {}, {})).html,
    /Nothing is waiting/,
  );
});

test("flights are within policy", async () => {
  const { app, decisions } = harness();
  await app.route("POST", "/missions", mission("fl-sfo-syd-qf74"), {});
  assert.equal(decisions[0].body.verdict, "approved");
});
