/**
 * A Person Server on node:http, configured by flags with environment
 * defaults. Run `node examples/server.ts --help` after `pnpm build`.
 */
import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  createPersonServer,
  DEFAULT_TENANT,
  type Approval,
} from "@introspection-sdk/person-server";

const MAX_BODY = 256 * 1024;

export const USAGE = `Usage: node examples/server.ts [options]

Runs an AAuth Person Server that speaks for anyone whose login hint is
user:<email>, with that email as their id. Approvals print to stdout; decide
them with POST <base-path>/consent/<id>/decision and the admin token. Put it
behind TLS at the issuer.

Options (each defaults to its environment variable, then to the default):
  --issuer <url>             PS_ISSUER          https://ps.example
  --trusted <urls>           PS_TRUSTED         https://api.introspection.dev
                             comma-separated agent providers
  --addr <host:port>         PS_ADDR            127.0.0.1:3400
  --base-path <path>         PS_BASE_PATH       the root
  --approver <id>            PS_APPROVER        none: each person decides their own
  --default-tenant <tenant>  PS_DEFAULT_TENANT  ${DEFAULT_TENANT}
  --require-tenant           PS_REQUIRE_TENANT  off (1 or true turns it on);
                             conflicts with --default-tenant
  -h, --help                 print this and exit

Environment only, never flags, since anything on the host that can list
processes reads their arguments:
  PS_SIGNING_KEY     PKCS#8 Ed25519 private key, PEM; unset, one per process
  PS_SUBJECT_SECRET  derives each person's directed sub; unset, one per process
  PS_ADMIN_TOKEN     bearer token for the management routes; unset, they are off
`;

export interface ServerOptions {
  issuer: string;
  trusted: string[];
  addr: string;
  host: string;
  port: number;
  basePath: string;
  approver?: string;
  defaultTenant?: string;
  requireTenant: boolean;
  signingKey?: string;
  subjectSecret?: string;
  adminToken?: string;
}

const nonEmpty = (value: string | undefined) => value || undefined;

/** Options from `argv` (without node and the script) and `env`; `"help"` for --help. Throws on a bad flag or value. */
export function parse(
  argv: string[],
  env: Record<string, string | undefined>,
): ServerOptions | "help" {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      issuer: { type: "string" },
      trusted: { type: "string" },
      addr: { type: "string" },
      "base-path": { type: "string" },
      approver: { type: "string" },
      "default-tenant": { type: "string" },
      "require-tenant": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";

  const issuer = values.issuer ?? env.PS_ISSUER ?? "https://ps.example";
  if (!URL.canParse(issuer)) throw new Error(`--issuer: not a URL: ${issuer}`);

  const trusted = (
    values.trusted ??
    env.PS_TRUSTED ??
    "https://api.introspection.dev"
  )
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  if (trusted.length === 0) throw new Error("--trusted: no agent providers");

  const addr = values.addr ?? env.PS_ADDR ?? "127.0.0.1:3400";
  const colon = addr.lastIndexOf(":");
  const port = Number(addr.slice(colon + 1));
  const host = addr.slice(0, colon).replace(/^\[(.*)\]$/, "$1");
  if (colon < 1 || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`--addr: expected host:port, got ${addr}`);

  const basePath = values["base-path"] ?? env.PS_BASE_PATH ?? "";
  if (basePath && !basePath.startsWith("/"))
    throw new Error(`--base-path: must start with /, got ${basePath}`);

  const requireEnv = env.PS_REQUIRE_TENANT;
  if (requireEnv && !["1", "true", "0", "false"].includes(requireEnv))
    throw new Error(`PS_REQUIRE_TENANT: expected 1 or true, got ${requireEnv}`);
  const requireTenant =
    values["require-tenant"] ?? (requireEnv === "1" || requireEnv === "true");
  const defaultTenant = nonEmpty(
    values["default-tenant"] ?? env.PS_DEFAULT_TENANT,
  );
  if (requireTenant && defaultTenant)
    throw new Error("--require-tenant and --default-tenant conflict");

  return {
    issuer,
    trusted,
    addr,
    host,
    port,
    basePath,
    approver: nonEmpty(values.approver ?? env.PS_APPROVER),
    defaultTenant,
    requireTenant,
    signingKey: nonEmpty(env.PS_SIGNING_KEY),
    subjectSecret: nonEmpty(env.PS_SUBJECT_SECRET),
    adminToken: nonEmpty(env.PS_ADMIN_TOKEN),
  };
}

async function readBody(
  req: IncomingMessage,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) return undefined;
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function main() {
  let options: ServerOptions | "help";
  try {
    options = parse(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (options === "help") {
    process.stdout.write(USAGE);
    return;
  }
  const { issuer, approver } = options;
  if (!options.signingKey || !options.subjectSecret)
    console.warn(
      "PS_SIGNING_KEY or PS_SUBJECT_SECRET unset: generated for this process, so its tokens and subs will not survive a restart",
    );

  const ps = await createPersonServer({
    issuer,
    trustedAgentProviders: options.trusted,
    basePath: options.basePath,
    defaultTenant: options.defaultTenant,
    requireTenant: options.requireTenant,
    signingKey: options.signingKey,
    subjectSecret: options.subjectSecret,
    adminToken: options.adminToken,
    directory: {
      person: (hint) => {
        if (!hint.startsWith("user:")) return undefined;
        const email = hint.slice("user:".length);
        return { id: email, email };
      },
      approver: () => (approver ? { id: approver } : undefined),
    },
    onApproval: (approval: Approval) =>
      console.log(
        `approval ${approval.id} for ${approval.approver.id} (tenant ${approval.tenant}): ${approval.kind} ${approval.description}`,
      ),
  });

  const server = createServer(async (req, res) => {
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const body = hasBody ? await readBody(req) : undefined;
    if (hasBody && body === undefined) {
      res.writeHead(413).end();
      return;
    }
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    const response = await ps.handle(
      new Request(new URL(req.url ?? "/", issuer), {
        method: req.method,
        headers,
        body,
      }),
    );
    res.writeHead(response.status, [...response.headers].flat());
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(options.port, options.host, () =>
    console.log(`Person Server ${issuer} on ${options.addr}`),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
