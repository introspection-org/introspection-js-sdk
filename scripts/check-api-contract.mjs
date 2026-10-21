/**
 * Compares this SDK's request/response surface against the published API reference.
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
 * Beyond fields, every operation in both references must be classified in
 * scripts/api-contract/operations.json as called by this SDK ("sdk") or
 * excluded with a reason, and the classification must agree with the route
 * literals in each package's `src` (see "operations" below).
 *
 * Deliberately NOT a unit test and NOT a pull-request gate. It reaches the
 * network and it goes red when the API changes, which is a fact about the world
 * and not about the commit under review — gating PRs on that trains people to
 * ignore it, and being ignorable is how the last one survived.
 *
 * Run: node scripts/check-api-contract.mjs [--spec URL|PATH] [--cp-spec URL|PATH]
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SPEC = "https://docs.introspection.dev/openapi/dataplane.json";
const DEFAULT_CP_SPEC =
  "https://docs.introspection.dev/openapi/controlplane.json";

const TYPES = resolve(ROOT, "packages/introspection-types/src/api.ts");
const BROWSER = resolve(
  ROOT,
  "packages/introspection-browser/src/api/tasks.ts",
);
const CONVERSATIONS = resolve(
  ROOT,
  "packages/introspection-types/src/conversations.ts",
);
/** Files searched for a base interface named in an `extends` clause. */
const SEARCH_PATH = [TYPES, CONVERSATIONS, BROWSER];

/**
 * Property names of an interface, following `extends` so
 * `TaskListParams extends ListParams` reports `limit`/`next`/`include_total`
 * too — they are on the wire regardless of which declaration carries them.
 *
 * Base interfaces are resolved across files, not just within one:
 * `ConversationListParams` lives in `conversations.ts` but extends
 * `CursorParams` from `api.ts`, and a same-file-only walk would silently
 * report its inherited `limit`/`next` as missing. A checker that emits a
 * finding it cannot substantiate is worse than one that stays quiet, because
 * it teaches the reader to skim past real ones.
 */
/** The file in SEARCH_PATH that declares `name`, if any. */
function declaringFile(name) {
  return SEARCH_PATH.find((candidate) =>
    new RegExp(`^export interface ${name}\\b`, "m").test(
      readFileSync(candidate, "utf8"),
    ),
  );
}

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
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== name)
      continue;
    found = true;

    for (const member of statement.members) {
      if (ts.isPropertySignature(member) && member.name) {
        members.add(member.name.getText(source));
      }
    }

    for (const clause of statement.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const type of clause.types) {
        const base = type.expression.getText(source);
        for (const inherited of interfaceMembers(
          declaringFile(base) ?? file,
          base,
          seen,
        )) {
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
  if (!schema)
    throw new Error(`the reference has no components.schemas.${name}`);
  return new Set(Object.keys(schema.properties ?? {}));
};

// Query parameters only. A templated route also declares its path segments as
// parameters, and counting those would report a path argument the caller passes
// positionally as a query parameter the SDK forgot.
const queryParameters = (spec, path, method) => {
  const params = spec.paths?.[path]?.[method]?.parameters;
  if (!params)
    throw new Error(`the reference has no parameters for ${method} ${path}`);
  return new Set(params.filter((p) => p.in === "query").map((p) => p.name));
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
    exempt: ["runtime_id"],
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
    exempt: ["resume"],
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
  // --- files ---------------------------------------------------------------
  {
    name: "File",
    where: "the file read model",
    sdk: () => interfaceMembers(TYPES, "File"),
    server: (spec) => schemaProperties(spec, "File"),
    extraMeans:
      "declared here but not returned by the API (the SDK describes a response that no longer exists)",
    missingMeans: "returned by the API but not surfaced by this SDK",
  },
  {
    name: "FileUpdateParams",
    where: "PATCH /v1/files/{id} body",
    sdk: () => interfaceMembers(TYPES, "FileUpdateParams"),
    server: (spec) => schemaProperties(spec, "FileUpdate"),
    extraMeans: "declared here but not accepted by the API",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
  {
    name: "FileListParams",
    where: "GET /v1/files query parameters",
    sdk: () => interfaceMembers(TYPES, "FileListParams"),
    server: (spec) => queryParameters(spec, "/v1/files", "get"),
    // `identity_key` is privileged-only and 403s for these credentials;
    // `task_id` is a scoping param a runner already carries.
    exempt: ["identity_key", "task_id"],
    missingIsFatal: false,
    extraMeans: "sent as a query parameter the API does not accept",
    missingMeans: "accepted by the API but not exposed here",
  },
  // --- shares --------------------------------------------------------------
  {
    name: "ShareCreateParams",
    where: "POST /v1/shares body",
    sdk: () => interfaceMembers(TYPES, "ShareCreateParams"),
    server: (spec) => schemaProperties(spec, "ShareCreate"),
    extraMeans: "declared here but not accepted by the API",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
  {
    name: "ResourceShare",
    where: "the share read model",
    sdk: () => interfaceMembers(TYPES, "ResourceShare"),
    server: (spec) => schemaProperties(spec, "ResourceShare"),
    extraMeans:
      "declared here but not returned by the API (the SDK describes a response that no longer exists)",
    missingMeans: "returned by the API but not surfaced by this SDK",
  },
  {
    name: "ShareUpdateParams",
    where: "PATCH /v1/shares/{id} body",
    sdk: () => interfaceMembers(TYPES, "ShareUpdateParams"),
    server: (spec) => schemaProperties(spec, "ShareUpdate"),
    extraMeans: "declared here but not accepted by the API",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
  {
    name: "ShareListParams",
    where: "GET /v1/shares query parameters",
    sdk: () => interfaceMembers(TYPES, "ShareListParams"),
    server: (spec) => queryParameters(spec, "/v1/shares", "get"),
    missingIsFatal: false,
    extraMeans: "sent as a query parameter the API does not accept",
    missingMeans: "accepted by the API but not exposed here",
  },
  // --- events --------------------------------------------------------------
  {
    name: "event envelope",
    where: "the common envelope on every event family",
    // One family stands in for all six: the envelope is shared, so a field
    // added or dropped there moves on every family at once.
    sdk: () => interfaceMembers(TYPES, "FeedbackEvent"),
    server: (spec) => schemaProperties(spec, "FeedbackEvent"),
    extraMeans:
      "declared here but not returned by the API (the SDK describes a response that no longer exists)",
    missingMeans: "returned by the API but not surfaced by this SDK",
  },
  {
    name: "EventListParams",
    where: "GET /v1/events query parameters",
    sdk: () => interfaceMembers(TYPES, "EventListParams"),
    server: (spec) => queryParameters(spec, "/v1/events", "get"),
    // Product-UI shaped filters; `event_id` is covered by `events.get`.
    exempt: [
      "event_id",
      "owner_key",
      "runtime_group_unattributed",
      "runtime_group_id",
      "conversation_ids",
      "trace_id",
      "span_id",
    ],
    // Resolved client-side and never sent: the ergonomic window aliases, and
    // `format`, which selects Arrow via the Accept header rather than a param.
    allowedExtra: ["order", "start", "end", "lookback", "format"],
    missingIsFatal: false,
    extraMeans: "sent as a query parameter the API does not accept",
    missingMeans: "accepted by the API but not exposed here",
  },
  {
    name: "AutomationTriggeredPayload",
    where: "introspection.automation.triggered payload",
    sdk: () => interfaceMembers(TYPES, "AutomationTriggeredPayload"),
    server: (spec) => schemaProperties(spec, "AutomationTriggered"),
    extraMeans:
      "declared here but not returned by the API (the SDK describes a response that no longer exists)",
    missingMeans: "returned by the API but not surfaced by this SDK",
  },
  {
    name: "AutomationSkippedPayload",
    where: "introspection.automation.skipped payload",
    sdk: () => interfaceMembers(TYPES, "AutomationSkippedPayload"),
    server: (spec) => schemaProperties(spec, "AutomationSkipped"),
    extraMeans:
      "declared here but not returned by the API (the SDK describes a response that no longer exists)",
    missingMeans: "returned by the API but not surfaced by this SDK",
  },
  // --- automations ---------------------------------------------------------
  {
    name: "Automation",
    where: "the automation read model",
    sdk: () => interfaceMembers(TYPES, "Automation"),
    server: (spec) => schemaProperties(spec, "Automation"),
    // Always null, and dropped by introspection-cloud#3154; this goes stale
    // (and fails) once the reference drops it too.
    exempt: ["agent_member_id"],
    extraMeans:
      "declared here but not returned by the API (the SDK describes a response that no longer exists)",
    missingMeans: "returned by the API but not surfaced by this SDK",
  },
  {
    name: "AutomationCreateParams",
    where: "POST /v1/automations body",
    sdk: () => interfaceMembers(TYPES, "AutomationCreateParams"),
    server: (spec) => schemaProperties(spec, "AutomationCreate"),
    extraMeans:
      "declared here but not accepted by the API (rejected with a 422 — the create body forbids undeclared fields)",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
  {
    name: "AutomationUpdateParams",
    where: "PATCH /v1/automations/{id} body",
    sdk: () => interfaceMembers(TYPES, "AutomationUpdateParams"),
    server: (spec) => schemaProperties(spec, "AutomationUpdate"),
    extraMeans:
      "declared here but not accepted by the API (rejected with a 422 — the update body forbids undeclared fields)",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
  {
    name: "AutomationTriggerResponse",
    where: "POST /v1/automations/{id}/trigger response",
    sdk: () => interfaceMembers(TYPES, "AutomationTriggerResponse"),
    server: (spec) => schemaProperties(spec, "AutomationTriggerResponse"),
    extraMeans:
      "declared here but not returned by the API (the SDK describes a response that no longer exists)",
    missingMeans: "returned by the API but not surfaced by this SDK",
  },
  {
    name: "AutomationListParams",
    where: "GET /v1/automations query parameters",
    sdk: () => interfaceMembers(TYPES, "AutomationListParams"),
    server: (spec) => queryParameters(spec, "/v1/automations", "get"),
    // Sent before the reference publishes it (introspection-cloud#3137);
    // drop the allowance once it does.
    allowedExtra: ["task_id"],
    missingIsFatal: true,
    extraMeans: "sent as a query parameter the API does not accept",
    missingMeans: "accepted by the API but not exposed here",
  },
  // --- conversations -------------------------------------------------------
  // There is deliberately no `Conversation` read-model surface: the published
  // reference declares no properties for that schema, so the comparison would
  // pass by doing nothing. The list filters are declared, so they are checked.
  {
    name: "ConversationListParams",
    where: "GET /v1/conversations query parameters",
    sdk: () => interfaceMembers(CONVERSATIONS, "ConversationListParams"),
    server: (spec) => queryParameters(spec, "/v1/conversations", "get"),
    // Product-UI shaped filters this SDK does not surface.
    exempt: ["conversation_ids", "owner_key", "resolution", "sentiment"],
    // Resolved client-side and never sent: the ergonomic window aliases, and
    // `format`, which selects Arrow via the Accept header.
    allowedExtra: ["order", "start", "end", "lookback", "format"],
    missingIsFatal: false,
    extraMeans: "sent as a query parameter the API does not accept",
    missingMeans: "accepted by the API but not exposed here",
  },
  // The export route needs its own surface. Widening the check still left
  // every route this SDK had just *gained* unchecked, so the conversation
  // export shipped without `start_date`/`end_date` and nothing noticed: a
  // guard that covers only what already existed goes blind exactly where new
  // code lands.
  {
    name: "ConversationExportParams",
    where: "GET /v1/conversations/{id}/export query parameters",
    sdk: () => interfaceMembers(CONVERSATIONS, "ConversationExportParams"),
    server: (spec) =>
      queryParameters(
        spec,
        "/v1/conversations/{conversation_id}/export",
        "get",
      ),
    missingIsFatal: true,
    extraMeans: "sent as a query parameter the API does not accept",
    missingMeans: "accepted by the API but not exposed here",
  },
  // The items route is where the ordering bug hid: this SDK declared an
  // `order` the route never accepted and omitted the window/share params it
  // did, and no surface covered it. A sub-resource is still a route.
  {
    name: "ConversationItemListParams",
    where: "GET /v1/conversations/{id}/items query parameters",
    sdk: () => interfaceMembers(CONVERSATIONS, "ConversationItemListParams"),
    server: (spec) =>
      queryParameters(spec, "/v1/conversations/{conversation_id}/items", "get"),
    missingIsFatal: true,
    extraMeans: "sent as a query parameter the API does not accept",
    missingMeans: "accepted by the API but not exposed here",
  },
  // --- control plane -------------------------------------------------------
  {
    name: "ExperimentListParams",
    where: "GET /v1/experiments query parameters",
    plane: "cp",
    sdk: () => interfaceMembers(TYPES, "ExperimentListParams"),
    server: (spec) => queryParameters(spec, "/v1/experiments", "get"),
    // The deprecated spelling of `project`; this SDK sends the current one.
    exempt: ["project_id"],
    missingIsFatal: false,
    extraMeans: "sent as a query parameter the API does not accept",
    missingMeans: "accepted by the API but not exposed here",
  },
  {
    name: "RecipeListParams",
    where: "GET /v1/recipes query parameters",
    plane: "cp",
    sdk: () => interfaceMembers(TYPES, "RecipeListParams"),
    server: (spec) => queryParameters(spec, "/v1/recipes", "get"),
    exempt: ["project_id"],
    missingIsFatal: false,
    extraMeans: "sent as a query parameter the API does not accept",
    missingMeans: "accepted by the API but not exposed here",
  },
  // The last list surface without a declaration, and it had drifted: this
  // SDK offered `only_active` and `exclude_yanked` filters the route never
  // accepted, so they rode along as query parameters the server discarded
  // and the caller's filter silently did nothing.
  {
    name: "RuntimeListParams",
    where: "GET /v1/runtimes query parameters",
    plane: "cp",
    sdk: () => interfaceMembers(TYPES, "RuntimeListParams"),
    server: (spec) => queryParameters(spec, "/v1/runtimes", "get"),
    exempt: ["project_id"],
    missingIsFatal: true,
    extraMeans: "sent as a query parameter the API does not accept",
    missingMeans: "accepted by the API but not exposed here",
  },
  // --- connectors ----------------------------------------------------------
  {
    name: "ConnectorListParams",
    where: "GET /v1/connectors query parameters",
    plane: "cp",
    sdk: () => interfaceMembers(TYPES, "CursorParams"),
    server: (spec) => queryParameters(spec, "/v1/connectors", "get"),
    // Project scope comes from the authenticated credential.
    exempt: ["project", "project_id"],
    missingIsFatal: false,
    extraMeans: "sent as a query parameter the API does not accept",
    missingMeans: "accepted by the API but not exposed here",
  },
  {
    name: "ConnectorCreateParams",
    where: "POST /v1/connectors body",
    plane: "cp",
    sdk: () => interfaceMembers(TYPES, "ConnectorCreateParams"),
    server: (spec) => schemaProperties(spec, "ConnectorCreate"),
    extraMeans: "declared here but not accepted by the API",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
  {
    name: "ConnectorUpdateParams",
    where: "PATCH /v1/connectors/{id} body",
    plane: "cp",
    sdk: () => interfaceMembers(TYPES, "ConnectorUpdateParams"),
    server: (spec) => schemaProperties(spec, "ConnectorUpdate"),
    extraMeans: "declared here but not accepted by the API",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
  {
    name: "ConnectionCreateParams",
    where: "POST /v1/connectors/{id}/connections body",
    plane: "cp",
    sdk: () => interfaceMembers(TYPES, "ConnectionCreateParams"),
    server: (spec) => schemaProperties(spec, "ConnectionCreate"),
    extraMeans: "declared here but not accepted by the API",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
  {
    // `connector_id` is a method argument here, not a caller-supplied field:
    // `authorize(connectorId, params)` merges it into the body.
    name: "ConnectorAuthorizeParams",
    where: "POST /v1/oauth/connections/authorize body",
    plane: "cp",
    sdk: () => interfaceMembers(TYPES, "ConnectorAuthorizeParams"),
    server: (spec) => schemaProperties(spec, "ConnectAuthorizeRequest"),
    exempt: ["connector_id"],
    extraMeans: "declared here but not accepted by the API",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
  {
    name: "ConnectorAuthorizeBinding",
    where: "POST /v1/oauth/connections/authorize body.binding",
    plane: "cp",
    sdk: () => interfaceMembers(TYPES, "ConnectorAuthorizeBinding"),
    server: (spec) => schemaProperties(spec, "ConnectBindingRequest"),
    extraMeans: "declared here but not accepted by the API",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
  {
    name: "ConnectorCustomAppSearchParams",
    where: "GET /v1/connectors/custom/apps query parameters",
    plane: "cp",
    sdk: () => interfaceMembers(TYPES, "ConnectorCustomAppSearchParams"),
    server: (spec) =>
      queryParameters(spec, "/v1/connectors/custom/apps", "get"),
    extraMeans: "sent as a query parameter the API does not accept",
    missingMeans: "accepted by the API but not exposed here",
  },
  // --- metrics -------------------------------------------------------------
  {
    name: "MetricQueryRequest",
    where: "POST /v1/metrics body",
    sdk: () => interfaceMembers(TYPES, "MetricQueryRequest"),
    server: (spec) => schemaProperties(spec, "MetricQueryRequest"),
    extraMeans: "declared here but not accepted by the API",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
  // --- task cancel ---------------------------------------------------------
  {
    name: "TaskCancelOptions",
    where: "POST /v1/tasks/{id}/runs/{rid}/cancel body",
    sdk: () => interfaceMembers(TYPES, "TaskCancelOptions"),
    server: (spec) => schemaProperties(spec, "TaskCancelRequest"),
    extraMeans: "declared here but not accepted by the API",
    missingMeans: "accepted by the API but unavailable to callers of this SDK",
  },
];

const difference = (a, b) => new Set([...a].filter((x) => !b.has(x)));
const listing = (fields) =>
  [...fields]
    .sort()
    .map((f) => `\n      ${f}`)
    .join("");

// --- operations -------------------------------------------------------------
// The surfaces above compare fields of routes someone already thought to list.
// A route nobody listed was invisible: a whole resource could ship, drift or
// disappear with nothing here noticing. So every operation in both references
// is classified in operations.json, either as called by this SDK or as excluded
// with a reason, and the classification is checked against the call sites.

const OPERATIONS = resolve(ROOT, "scripts/api-contract/operations.json");
const PACKAGES = resolve(ROOT, "packages");
const PLANE_NAMES = { dp: "dataplane", cp: "controlplane" };
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
/** Helpers that take a route as an argument and always send it as a GET. */
const GET_HELPERS = new Set(["paginateGet", "listRead", "arrowRead"]);

/** Path parameters compare by position, not by name. */
const templateKey = (path) => path.replace(/\{[^}]*\}/g, "{}");

function sourceFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((f) => /(^|\/)src\//.test(f) && f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".d.ts") && !f.endsWith(".test.ts"))
    .filter((f) => !f.split("/").includes("node_modules"))
    .map((f) => resolve(dir, f));
}

/**
 * The route templates an expression can evaluate to, with every `${...}`
 * that is not a known route prefix read as a path parameter. Empty when the
 * expression is not a route.
 *
 * `aliases` maps a local `const` or helper function to the routes it holds,
 * so `path: tagPath(kind, name)` and `${runPath}/stream` resolve too.
 */
function routesOf(node, aliases) {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.startsWith("/v1/") ? [node.text] : [];
  }
  if (ts.isIdentifier(node)) return aliases.get(node.text) ?? [];
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    return aliases.get(node.expression.text) ?? [];
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...routesOf(node.whenTrue, aliases),
      ...routesOf(node.whenFalse, aliases),
    ];
  }
  if (ts.isParenthesizedExpression(node)) {
    return routesOf(node.expression, aliases);
  }
  if (!ts.isTemplateExpression(node)) return [];

  let prefixes = [node.head.text];
  node.templateSpans.forEach((span, i) => {
    const base =
      i === 0 && node.head.text === ""
        ? routesOf(span.expression, aliases)
        : [];
    prefixes = base.length
      ? base.map((b) => b + span.literal.text)
      : prefixes.map((p) => `${p}{}${span.literal.text}`);
  });
  return prefixes.filter((p) => p.startsWith("/v1/"));
}

/** `const x = <route>` and functions returning a route, in one file. */
function collectAliases(source) {
  const aliases = new Map();
  // Post-order, so a helper's own `const base = ...` is known before its
  // returns are read.
  const visit = (node) => {
    ts.forEachChild(node, visit);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const routes = routesOf(node.initializer, aliases);
      if (routes.length) aliases.set(node.name.text, routes);
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const routes = [];
      const returns = (inner) => {
        if (ts.isFunctionLike(inner)) return;
        if (ts.isReturnStatement(inner)) {
          routes.push(...routesOf(inner.expression, aliases));
        }
        ts.forEachChild(inner, returns);
      };
      ts.forEachChild(node.body, returns);
      if (routes.length) aliases.set(node.name.text, routes);
    }
  };
  visit(source);
  return aliases;
}

const calleeName = (call) =>
  ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : ts.isIdentifier(call.expression)
      ? call.expression.text
      : undefined;

/**
 * Every route this SDK sends, as `{ method, path, at }`. A route is sent where
 * it is the `path` of a request object (`{ method, path }`, or a `stream()`
 * call, which is always a GET) or an argument of a GET-only helper. A route in
 * any other position, such as a comparison or a doc comment, is not a call.
 */
function sdkCalls() {
  const calls = [];
  const unknownMethod = [];

  for (const file of sourceFiles(PACKAGES)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("/v1/")) continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const aliases = collectAliases(source);
    const at = (node) =>
      `${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;

    const visit = (node) => {
      if (
        (ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node)) &&
        node.name.getText(source) === "path" &&
        ts.isObjectLiteralExpression(node.parent)
      ) {
        const routes = routesOf(node.initializer ?? node.name, aliases);
        if (routes.length) {
          const methodProp = node.parent.properties.find(
            (p) =>
              ts.isPropertyAssignment(p) && p.name.getText(source) === "method",
          );
          const call = node.parent.parent;
          let method;
          if (methodProp && ts.isStringLiteralLike(methodProp.initializer)) {
            method = methodProp.initializer.text;
          } else if (
            !methodProp &&
            ts.isCallExpression(call) &&
            calleeName(call) === "stream"
          ) {
            method = "GET";
          }
          for (const path of routes) {
            if (method) calls.push({ method, path, at: at(node) });
            else unknownMethod.push(`${path} (${at(node)})`);
          }
        }
      }
      if (ts.isCallExpression(node) && GET_HELPERS.has(calleeName(node))) {
        for (const arg of node.arguments) {
          for (const path of routesOf(arg, aliases)) {
            calls.push({ method: "GET", path, at: at(arg) });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { calls, unknownMethod };
}

/** `{ "<METHOD> <path>": plane }` for every operation in both references. */
function specOperations(specs) {
  const operations = new Map();
  for (const [plane, spec] of Object.entries(specs)) {
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const method of HTTP_METHODS) {
        if (item[method])
          operations.set(`${method.toUpperCase()} ${path}`, plane);
      }
    }
  }
  return operations;
}

function checkOperations(specs) {
  const problems = [];
  const classified = JSON.parse(readFileSync(OPERATIONS, "utf8"));
  const operations = specOperations(specs);

  // The spec operation each normalized `<METHOD> <template>` names.
  const byKey = new Map();
  for (const op of operations.keys()) {
    const [method, path] = op.split(" ");
    byKey.set(`${method} ${templateKey(path)}`, op);
  }

  const { calls, unknownMethod } = sdkCalls();
  const called = new Map();
  const dead = [];
  for (const call of calls) {
    const op = byKey.get(`${call.method} ${templateKey(call.path)}`);
    if (!op) {
      dead.push(`${call.method} ${call.path} (${call.at})`);
      continue;
    }
    if (!called.has(op)) called.set(op, []);
    called.get(op).push(call.at);
  }

  const unclassified = [];
  const stale = [];
  const sdkUncalled = [];
  const excludedCalled = [];
  for (const [plane, name] of Object.entries(PLANE_NAMES)) {
    const entries = classified[name] ?? {};
    for (const [op, opPlane] of operations) {
      if (opPlane === plane && !(op in entries))
        unclassified.push(`${name}: ${op}`);
    }
    for (const [op, entry] of Object.entries(entries)) {
      if (operations.get(op) !== plane) {
        stale.push(`${name}: ${op}`);
      } else if (entry === "sdk") {
        if (!called.has(op)) sdkUncalled.push(`${name}: ${op}`);
      } else if (
        typeof entry?.excluded !== "string" ||
        !entry.excluded.trim()
      ) {
        problems.push(
          `operations.json — ${name}: ${op}\n  must be "sdk" or { "excluded": "<reason>" }`,
        );
      } else if (called.has(op)) {
        excludedCalled.push(`${name}: ${op} (${called.get(op).join(", ")})`);
      }
    }
  }

  const report = (items, means) => {
    if (items.length) problems.push(`operations — ${means}:${listing(items)}`);
  };
  report(
    unclassified,
    'in the API reference but not classified in operations.json (add it as "sdk" or excluded with a reason)',
  );
  report(
    dead,
    "called by this SDK but not in the API reference (the SDK calls a route that does not exist)",
  );
  report(
    stale,
    "classified in operations.json but no longer in the API reference (drop the entry)",
  );
  report(
    sdkUncalled,
    'classified "sdk" but no call site in packages/*/src sends it',
  );
  report(
    excludedCalled,
    'classified as excluded but called by this SDK (classify it "sdk")',
  );
  report(
    unknownMethod,
    "a route sent without a literal `method`, so it cannot be classified",
  );

  return { problems, count: operations.size };
}

async function loadSpec(source) {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const response = await fetch(source, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

function specArg(name, fallback) {
  const flag = process.argv.indexOf(name);
  return flag === -1 ? fallback : process.argv[flag + 1];
}

async function main() {
  const specSource = specArg("--spec", DEFAULT_SPEC);
  const cpSpecSource = specArg("--cp-spec", DEFAULT_CP_SPEC);

  // The two planes are separate services with separate references. The
  // control-plane half went unchecked entirely until an experiments filter
  // the API does not accept shipped in two SDKs at once.
  const specs = {};
  for (const [plane, source] of [
    ["dp", specSource],
    ["cp", cpSpecSource],
  ]) {
    try {
      specs[plane] = await loadSpec(source);
    } catch (error) {
      console.error(
        `could not read the API reference at ${source}: ${error.message}`,
      );
      return 1;
    }
  }

  const problems = [];

  for (const surface of SURFACES) {
    let server;
    let sdk;
    try {
      server = surface.server(specs[surface.plane ?? "dp"]);
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
        console.log(
          `note: ${surface.name}: ${surface.missingMeans}:${listing(missing)}\n`,
        );
      } else {
        lines.push(`  ${surface.missingMeans}:${listing(missing)}`);
        fatal = true;
      }
    }
    if (stale.size) {
      lines.push(
        `  exempted here but no longer in the API (drop the exemption):${listing(stale)}`,
      );
      fatal = true;
    }

    if (fatal)
      problems.push(`${surface.name} — ${surface.where}\n${lines.join("\n")}`);
  }

  const operations = checkOperations(specs);
  problems.push(...operations.problems);

  if (problems.length) {
    console.error(problems.join("\n\n"));
    console.error(`\nreference: ${specSource} + ${cpSpecSource}`);
    return 1;
  }

  console.log(
    `✓ SDK surface matches the published reference (${SURFACES.length} surfaces, ${operations.count} operations)`,
  );
  return 0;
}

process.exit(await main());
