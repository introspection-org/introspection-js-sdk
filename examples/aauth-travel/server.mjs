// One process for the demo's provider side: the booking API (/v1/*), Acme's
// Person Server (/missions) and Dana's approval page (/approvals).
import { createServer } from "node:http";

import { createBooking } from "./lib/booking.mjs";
import { createPersonServer } from "./lib/person-server.mjs";

const PORT = Number(process.env.PORT ?? 3400);
const policy = {
  nightly_caps: { SYD: 300, MEL: 250 },
  approver: process.env.ACME_APPROVER ?? "dana@acme.example",
};

export function createApp({ token, controlPlaneUrl, fetchImpl, notify }) {
  const booking = createBooking({ token });
  const personServer = createPersonServer({
    policy,
    controlPlaneUrl,
    fetchImpl,
    notify,
  });

  async function route(method, path, body, headers) {
    if (method === "POST" && path === "/v1/search") return booking.search(body);
    if (method === "POST" && path === "/v1/reserve")
      return booking.reserve(body, headers);
    if (method === "POST" && path === "/missions")
      return personServer.receive(body);
    const decision = path.match(/^\/approvals\/([^/]+)\/(approve|decline)$/);
    if (method === "POST" && decision) {
      return personServer.decide(
        decision[1],
        decision[2] === "approve" ? "approved" : "denied",
      );
    }
    if (method === "GET" && path === "/approvals")
      return { status: 200, html: approvalsPage(personServer.pending) };
    return { status: 404, body: { error: "not found" } };
  }

  return { booking, personServer, route };
}

function escape(text) {
  return String(text).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

function approvalsPage(pending) {
  const rows = [...pending.values()]
    .map(
      (m) => `<li><p>${escape(m.reason)}</p>
<form method="post" action="/approvals/${escape(m.mission_id)}/approve"><button>Approve</button></form>
<form method="post" action="/approvals/${escape(m.mission_id)}/decline"><button>Decline</button></form></li>`,
    )
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>Acme approvals</title>
<h1>Acme travel approvals</h1><ul>${rows || "<li>Nothing is waiting.</li>"}</ul>`;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.env.BOOKING_PROVIDER_TOKEN;
  const controlPlaneUrl =
    process.env.INTROSPECTION_CONTROL_PLANE_URL ?? "http://localhost:8000";
  if (!token)
    throw new Error(
      "set BOOKING_PROVIDER_TOKEN to the booking connection's access_token",
    );
  const app = createApp({
    token,
    controlPlaneUrl,
    fetchImpl: fetch,
    notify: console.log,
  });
  createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    const body = request.method === "POST" ? await readJson(request) : {};
    const result = await app.route(
      request.method,
      url.pathname,
      body,
      request.headers,
    );
    if (result.html) {
      response
        .writeHead(result.status, {
          "content-type": "text/html; charset=utf-8",
        })
        .end(result.html);
    } else if (url.pathname.startsWith("/approvals/")) {
      response.writeHead(303, { location: "/approvals" }).end();
    } else {
      response
        .writeHead(result.status, { "content-type": "application/json" })
        .end(JSON.stringify(result.body));
    }
  }).listen(PORT, () =>
    console.log(`aauth-travel on http://localhost:${PORT}`),
  );
}
