// Alder Court's works API and Person Server on one port, told apart by host,
// for a cloud runtime to reach through two https tunnels. ALL DATA IS FICTIONAL.
//
//   WORKS_ISSUER=https://<works tunnel> PS_ISSUER=https://<ps tunnel> \
//   TRUSTED_AGENT_PROVIDERS=<the control plane's AAuth agent issuer> \
//   ADMIN_TOKEN=<secret> node server.mjs
//
// Keep WORKS_SIGNING_KEY and PS_SIGNING_KEY (PKCS#8 Ed25519 PEMs) stable for
// anything longer than a demo: verifiers cache an issuer's keys.
import { createServer } from "node:http";
import { Readable } from "node:stream";

import { createOwners } from "./lib/owners.mjs";
import { createWorks } from "./lib/works.mjs";

const need = (name) =>
  process.env[name] || (console.error(`set ${name}`), process.exit(1));
const WORKS = need("WORKS_ISSUER").replace(/\/+$/, "");
const PS = need("PS_ISSUER").replace(/\/+$/, "");
const agentProviders = need("TRUSTED_AGENT_PROVIDERS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const onEvent = (type, data) =>
  console.log(`[${type}] ${JSON.stringify(data)}`);

const works = await createWorks({
  issuer: WORKS,
  personServers: [PS],
  agentProviders,
  signingKey: process.env.WORKS_SIGNING_KEY,
  onEvent,
});
const owners = await createOwners({
  issuer: PS,
  trustedAgentProviders: agentProviders,
  signingKey: process.env.PS_SIGNING_KEY,
  adminToken: process.env.ADMIN_TOKEN,
  onEvent,
});
const byHost = {
  [new URL(WORKS).host]: [WORKS, works],
  [new URL(PS).host]: [PS, owners],
};

createServer(async (req, res) => {
  const [origin, party] =
    byHost[req.headers["x-forwarded-host"] ?? req.headers.host] ?? [];
  if (!party) return res.writeHead(404).end("unknown host\n");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const response = await party.handle(
    new Request(new URL(req.url, origin), {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: "half",
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(Number(process.env.PORT || 4300), () =>
  console.log(`works ${WORKS}\nps    ${PS}\n(fictional data)`),
);
