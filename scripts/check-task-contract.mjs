/**
 * Compares this SDK's task surface against the published API reference.
 *
 * `mode` and `system_id` sat on `TaskCreateParams` for the entire life of their
 * retirement, `Task.mode` described a field the API had stopped returning, and
 * `TaskListParams.modes` was a filter the API never had. None of it failed:
 * TypeScript erases at runtime, so the types lied rather than broke, and
 * nothing in CI knew what the API accepted.
 *
 * The reference at docs.introspection.dev is generated from the Data Plane API
 * itself, so comparing against it compares against the API's own declaration
 * rather than a second hand-maintained copy.
 *
 * Types have no runtime representation to reflect over, so the interfaces are
 * read with the TypeScript compiler API — which means this checks the source of
 * truth developers actually edit, including inherited members through `extends`.
 *
 * Deliberately NOT a unit test and NOT a pull-request gate. It reaches the
 * network and it goes red when the API changes, which is a fact about the world
 * and not about the commit under review — gating PRs on that trains people to
 * ignore it, and being ignorable is how the last one survived.
 *
 * Run: node scripts/check-task-contract.mjs [--spec URL|PATH]
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SPEC = "https://docs.introspection.dev/openapi/dataplane.json";

const TYPES = resolve(ROOT, "packages/introspection-types/src/api.ts");
const BROWSER = resolve(ROOT, "packages/introspection-browser/src/api/tasks.ts");

/**
 * Property names of an interface, following `extends` within the same file so
 * `TaskListParams extends ListParams` reports `limit`/`next`/`include_total`
 * too — they are on the wire regardless of which declaration carries them.
 */
function interfaceMembers(file, name, seen = new Set()) {
  if (seen.has(name)) return new Set();
  seen.add(name);

  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  const members = new Set();
  let found = false;

  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== name) continue;
    found = true;

    for (const member of statement.members) {
      if (ts.isPropertySignature(member) && member.name) {
        members.add(member.name.getText(source));
      }
    }

    for (const clause of statement.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const type of clause.types) {
        for (const inherited of interfaceMembers(file, type.expression.getText(source), seen)) {
          members.add(inherited);
        }
      }
    }
  }

  if (!found && seen.size === 1) {
    throw new Error(`no interface named ${name} in ${file}`);
  }
  return members;
}

const schemaProperties = (spec, name) => {
  const schema = spec.components?.schemas?.[name];
  if (!schema) throw new Error(`the reference has no components.schemas.${name}`);
  return new Set(Object.keys(schema.properties ?? {}));
};

const queryParameters = (spec, path, method) => {
  const params = spec.paths?.[path]?.[method]?.parameters;
  if (!params) throw new Error(`the reference has no parameters for ${method} ${path}`);
  return new Set(params.map((p) => p.name));
};

const SURFACES = [
  {
    name: "TaskCreateParams",
    where: "POST /v1/tasks body (runner-bound client)",
    sdk: () => interfaceMembers(TYPES, "TaskCreateParams"),
    server: (spec) => schemaProperties(spec, "TaskCreate"),
    // Runner-bound: the credential's claim is authoritative for runtime
    // selection and the API ignores a body `runtime_id` from such a caller, so
    // exposing it would be a field that silently does nothing.
    exempt: ["runtime_id", "repository_id"],
    // `repository_id` is retired from the public create body: the API accepted
    // it, stamped it into task metadata, and read it nowhere. Listed here so
    // the check stays green against a published reference that still declares
    // it; once the reference catches up, the stale-exemption rule fails and
    // this line comes out.
    extraMeans:
      "declared here but not accepted by the API (rejected with a 422 — the create body forbids undeclared fields)",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
  {
    name: "CreateTaskParams",
    where: "POST /v1/tasks body (browser client)",
    sdk: () => interfaceMembers(BROWSER, "CreateTaskParams"),
    server: (spec) => schemaProperties(spec, "TaskCreate"),
    // `identity` is client-side sugar, not a wire field: the browser client
    // folds it into `metadata.identity`, which the API reads only when the
    // caller's token carries no identity claim of its own.
    allowedExtra: ["identity"],
    exempt: ["repository_id"],
    // `repository_id` is retired from the public create body: the API accepted
    // it, stamped it into task metadata, and read it nowhere. Listed here so
    // the check stays green against a published reference that still declares
    // it; once the reference catches up, the stale-exemption rule fails and
    // this line comes out.
    extraMeans:
      "declared here but not accepted by the API (rejected with a 422 — the create body forbids undeclared fields)",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
  {
    name: "Task",
    where: "the task read model",
    sdk: () => interfaceMembers(TYPES, "Task"),
    server: (spec) => schemaProperties(spec, "Task"),
    extraMeans:
      "declared here but not returned by the API (the SDK describes a response that no longer exists)",
    missingMeans: "returned by the API but not surfaced by this SDK",
  },
  {
    name: "TaskRunCreateParams",
    where: "POST /v1/tasks/{id}/runs body",
    sdk: () => interfaceMembers(TYPES, "TaskRunCreateParams"),
    server: (spec) => schemaProperties(spec, "TaskRunCreate"),
    // `resume` is a separate typed call on this client, not a field here.
    // `message` was the legacy shorthand for `prompt.text`, retired from the
    // API in the same cycle; the exemption self-clears as above.
    exempt: ["resume", "message"],
    extraMeans: "declared here but not accepted by the API",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
  {
    name: "TaskListParams",
    where: "GET /v1/tasks query parameters",
    sdk: () => interfaceMembers(TYPES, "TaskListParams"),
    server: (spec) => queryParameters(spec, "/v1/tasks", "get"),
    // Product-UI shaped filters, whose only callers are the frontend. Which
    // filters to expose is a product decision, so absence is reported and does
    // not fail.
    exempt: ["runtime_id", "runtime_ids", "updated_after", "conversation_id"],
    missingIsFatal: false,
    extraMeans: "sent as a query parameter the API does not accept",
    missingMeans: "accepted by the API but not exposed here",
  },
];

const difference = (a, b) => new Set([...a].filter((x) => !b.has(x)));
const listing = (fields) => [...fields].sort().map((f) => `\n      ${f}`).join("");

async function loadSpec(source) {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

async function main() {
  const flag = process.argv.indexOf("--spec");
  const specSource = flag === -1 ? DEFAULT_SPEC : process.argv[flag + 1];

  let spec;
  try {
    spec = await loadSpec(specSource);
  } catch (error) {
    console.error(`could not read the API reference at ${specSource}: ${error.message}`);
    return 1;
  }

  const problems = [];

  for (const surface of SURFACES) {
    let server;
    let sdk;
    try {
      server = surface.server(spec);
      sdk = surface.sdk();
    } catch (error) {
      problems.push(`${surface.name} — ${surface.where}\n  ${error.message}`);
      continue;
    }

    const exempt = new Set(surface.exempt ?? []);
    const allowedExtra = new Set(surface.allowedExtra ?? []);

    const extra = difference(difference(sdk, server), allowedExtra);
    const missing = difference(difference(server, sdk), exempt);
    // An exemption naming a field the API no longer has would otherwise stay
    // quietly true forever, hiding nothing.
    const stale = difference(exempt, server);

    const lines = [];
    let fatal = false;

    if (extra.size) {
      lines.push(`  ${surface.extraMeans}:${listing(extra)}`);
      fatal = true;
    }
    if (missing.size) {
      if (surface.missingIsFatal === false) {
        console.log(`note: ${surface.name}: ${surface.missingMeans}:${listing(missing)}\n`);
      } else {
        lines.push(`  ${surface.missingMeans}:${listing(missing)}`);
        fatal = true;
      }
    }
    if (stale.size) {
      lines.push(`  exempted here but no longer in the API (drop the exemption):${listing(stale)}`);
      fatal = true;
    }

    if (fatal) problems.push(`${surface.name} — ${surface.where}\n${lines.join("\n")}`);
  }

  if (problems.length) {
    console.error(problems.join("\n\n"));
    console.error(`\nreference: ${specSource}`);
    return 1;
  }

  console.log(`✓ task surface matches the published reference (${SURFACES.length} surfaces)`);
  return 0;
}

process.exit(await main());
