/**
 * Compares this SDK's request/response surface against the API reference.
 *
 * `mode` and `system_id` sat on `TaskCreateParams` for the entire life of their
 * retirement, `Task.mode` described a field the API had stopped returning, and
 * `TaskListParams.modes` was a filter the API never had. None of it failed:
 * TypeScript erases at runtime, so the types lied rather than broke, and
 * nothing in CI knew what the API accepted.
 *
 * The references are the OpenAPI documents the Control Plane serves for both
 * planes, generated from the APIs themselves. They also say who each route is
 * for: every public operation carries
 * `x-introspection: { visibility, clients: [...] }`, and routes no client may
 * call are not in them at all. That classification is the only one; this
 * check keeps no list of its own.
 *
 * It fails when:
 *
 * - an operation whose `x-introspection.clients` includes "sdk" is sent from
 *   no call site in each package's `src`;
 * - a call site sends a `/v1/...` route that neither reference has;
 * - a call site's request body, query parameters or response differ from the
 *   operation's schemas: field names, required versus optional, and basic
 *   types, following `$ref` into nested schemas (see api-contract/fields.mjs).
 *   A parameter whose own `x-introspection.clients` leaves out "sdk" (the
 *   Data Plane's `lane` and `project_id` say `clients: []`) is not expected.
 *
 * Types have no runtime representation to reflect over, so they are read
 * with the TypeScript checker at the call site itself: the type that actually
 * goes on the wire, inherited members included.
 *
 * A call site whose types the checker cannot resolve (a generic, a
 * `Record<string, unknown>`, a direct `fetch()`) is a warning, not a failure:
 * it is printed under "Warning: SDK has no concrete types" with its
 * operation, the part (body, query or response) and the call site, and does
 * not change the exit code. Fixing it is SDK work on the call site's types,
 * not drift in the API.
 *
 * Deliberately NOT a unit test and NOT a pull-request gate. It reaches the
 * network and it goes red when the API changes, which is a fact about the world
 * and not about the commit under review — gating PRs on that trains people to
 * ignore it, and being ignorable is how the last one survived.
 * .github/workflows/api-contract.yml runs it nightly against staging.
 *
 * Run: node scripts/check-api-contract.mjs [--dataplane URL|PATH] [--controlplane URL|PATH]
 * env: API_CONTRACT_DATAPLANE, API_CONTRACT_CONTROLPLANE  the same, for a flag
 *      left out (default: staging, https://api.staging.introspection.dev/openapi/<plane>.json)
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  callSiteTypes,
  compareCallSite,
  createProgram,
  specShapes,
} from "./api-contract/fields.mjs";
import { referenceSource } from "./api-contract/reference.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The client name this SDK goes by in `x-introspection.clients`. */
const CLIENT = "sdk";

// --- operations -------------------------------------------------------------
// A field check over routes someone thought to list leaves a route nobody
// listed invisible: a whole resource could ship, drift or disappear with
// nothing here noticing. So every operation the reference marks for this
// client must have a call site, and every call site must name an operation.

const PACKAGES = resolve(ROOT, "packages");
const PLANE_NAMES = { dp: "dataplane", cp: "controlplane" };
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
/** Helpers that take a route as an argument and always send it as a GET. */
const GET_HELPERS = new Set(["paginateGet", "listRead", "arrowRead"]);
/** Direct fetch calls, such as the OAuth routes that bypass the HTTP client. */
const FETCH_CALLEES = new Set(["fetch", "fetchImpl"]);

const listing = (items) =>
  [...items]
    .sort()
    .map((item) => `\n      ${item}`)
    .join("");

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
 * `aliases` maps an identifier to the routes the local `const` or helper
 * function it refers to holds, so `path: tagPath(kind, name)` and
 * `${runPath}/stream` resolve too.
 *
 * With `url`, the expression is a whole URL: a leading `${...}` before the
 * `/v1/` route is the base URL (`${baseApiUrl}/v1/oauth/token`), not a
 * parameter.
 */
function routesOf(node, aliases, url = false) {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.startsWith("/v1/") ? [node.text] : [];
  }
  if (ts.isIdentifier(node)) return aliases(node);
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    return aliases(node.expression);
  }
  if (ts.isConditionalExpression(node)) {
    return [
      ...routesOf(node.whenTrue, aliases, url),
      ...routesOf(node.whenFalse, aliases, url),
    ];
  }
  if (ts.isParenthesizedExpression(node)) {
    return routesOf(node.expression, aliases, url);
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
  return prefixes
    .map((p) => (url && p.startsWith("{}/v1/") ? p.slice(2) : p))
    .filter((p) => p.startsWith("/v1/"));
}

/**
 * `const x = <route>` and functions returning a route, in one file, keyed by
 * the checker's symbol so two same-named locals in different scopes stay
 * apart. Returns the lookup from an identifier to its routes.
 */
function collectAliases(source, checker) {
  const routesBySymbol = new Map();
  const symbolOf = (id) =>
    ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
      ? checker.getShorthandAssignmentValueSymbol(id.parent)
      : checker.getSymbolAtLocation(id);
  const aliases = (id) => routesBySymbol.get(symbolOf(id)) ?? [];
  // Post-order, so a helper's own `const base = ...` is known before its
  // returns are read.
  const visit = (node) => {
    ts.forEachChild(node, visit);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      // Read as a URL: a const may hold the whole URL a `fetch` sends
      // (`${baseApiUrl}/v1/oauth/token`), and a route never starts with
      // a parameter.
      const routes = routesOf(node.initializer, aliases, true);
      if (routes.length) routesBySymbol.set(symbolOf(node.name), routes);
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const routes = [];
      const returns = (inner) => {
        if (ts.isFunctionLike(inner)) return;
        if (ts.isReturnStatement(inner)) {
          routes.push(...routesOf(inner.expression, aliases, true));
        }
        ts.forEachChild(inner, returns);
      };
      ts.forEachChild(node.body, returns);
      if (routes.length) routesBySymbol.set(symbolOf(node.name), routes);
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
 * Every route this SDK sends, as `{ method, path, at, site }`, where `site` is
 * the call the field check reads types from. A route is sent where
 * it is the `path` of the first argument to `request()` or `stream()`
 * (which is always a GET), an argument of a GET-only helper, or the URL of
 * a direct `fetch(url, { method })` call (a GET without `method`). A route in
 * any other position, such as a comparison or a doc comment, is not a call.
 */
function sdkCalls(program, files) {
  const calls = [];
  const unknownMethod = [];
  const checker = program.getTypeChecker();

  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source?.text.includes("/v1/")) continue;
    const aliases = collectAliases(source, checker);
    const at = (node) =>
      `${relative(ROOT, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;

    const visit = (node) => {
      if (
        (ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node)) &&
        node.name.getText(source) === "path" &&
        ts.isObjectLiteralExpression(node.parent) &&
        ts.isCallExpression(node.parent.parent) &&
        ts.isPropertyAccessExpression(node.parent.parent.expression) &&
        ["request", "stream"].includes(calleeName(node.parent.parent)) &&
        node.parent.parent.arguments[0] === node.parent
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
          const site = { kind: calleeName(call), call };
          for (const path of routes) {
            if (method) calls.push({ method, path, at: at(node), site });
            else unknownMethod.push(`${path} (${at(node)})`);
          }
        }
      }
      if (ts.isCallExpression(node) && GET_HELPERS.has(calleeName(node))) {
        for (const arg of node.arguments) {
          for (const path of routesOf(arg, aliases)) {
            calls.push({
              method: "GET",
              path,
              at: at(arg),
              site: { kind: "helper", helper: calleeName(node), call: node },
            });
          }
        }
      }
      if (ts.isCallExpression(node) && FETCH_CALLEES.has(calleeName(node))) {
        const [input, init] = node.arguments;
        const methodProp =
          init && ts.isObjectLiteralExpression(init)
            ? init.properties.find(
                (p) =>
                  ts.isPropertyAssignment(p) &&
                  p.name.getText(source) === "method",
              )
            : undefined;
        let method;
        if (methodProp && ts.isStringLiteralLike(methodProp.initializer)) {
          method = methodProp.initializer.text;
        } else if (
          !methodProp &&
          (!init || ts.isObjectLiteralExpression(init))
        ) {
          method = "GET";
        }
        for (const path of routesOf(input, aliases, true)) {
          if (method)
            calls.push({
              method,
              path,
              at: at(input),
              site: { kind: "fetch", call: node },
            });
          else unknownMethod.push(`${path} (${at(input)})`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { calls, unknownMethod };
}

/**
 * Every operation in both references, keyed `<METHOD> <path>`, with its plane
 * and the clients its `x-introspection` names, plus the operations both
 * references declare: a call site does not say which plane it sends to.
 */
function specOperations(specs) {
  const operations = new Map();
  const inBoth = [];
  for (const [plane, spec] of Object.entries(specs)) {
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op) continue;
        const key = `${method.toUpperCase()} ${path}`;
        if (operations.has(key)) inBoth.push(key);
        operations.set(`${method.toUpperCase()} ${path}`, {
          plane,
          clients: op["x-introspection"]?.clients ?? [],
        });
      }
    }
  }
  return { operations, inBoth };
}

/** Operation-level findings: the reference's classification against call sites. */
function checkOperations(specs, calls, unknownMethod) {
  const { operations, inBoth } = specOperations(specs);

  // The spec operation each normalized `<METHOD> <template>` names.
  const byKey = new Map();
  for (const op of operations.keys()) {
    const [method, path] = op.split(" ");
    byKey.set(`${method} ${templateKey(path)}`, op);
  }

  const called = new Map();
  const notInReference = [];
  for (const call of calls) {
    const op = byKey.get(`${call.method} ${templateKey(call.path)}`);
    if (!op) {
      notInReference.push(`${call.method} ${call.path} (${call.at})`);
      continue;
    }
    if (!called.has(op)) called.set(op, []);
    if (!called.get(op).some((c) => c.at === call.at))
      called.get(op).push(call);
  }

  const uncalled = [];
  for (const [op, { plane, clients }] of operations) {
    if (clients.includes(CLIENT) && !called.has(op))
      uncalled.push(`${PLANE_NAMES[plane]}: ${op}`);
  }

  const problems = [];
  const report = (items, means) => {
    if (items.length)
      problems.push(
        `operations — ${means} (${items.length}):${listing(items)}`,
      );
  };
  report(
    uncalled,
    `the reference lists "${CLIENT}" in x-introspection.clients, but no call site in packages/*/src sends it`,
  );
  report(
    notInReference,
    "called by this SDK but not in either reference (the SDK calls a route that does not exist)",
  );
  report(
    inBoth,
    "in both references, so a call site cannot be matched to one plane",
  );
  report(
    unknownMethod,
    "a route sent without a literal `method`, so it cannot be matched",
  );

  const calledOperations = [...called].map(([op, sites]) => ({
    plane: operations.get(op).plane,
    op,
    sites,
  }));
  return {
    problems,
    count: operations.size,
    missing: uncalled.length,
    notInReference: notInReference.length,
    unmatched: inBoth.length + unknownMethod.length,
    calledOperations,
  };
}

// --- fields -----------------------------------------------------------------

const FINDING_MEANS = {
  missing:
    "field missing in SDK (in the reference, but this call site neither sends nor reads it)",
  extra:
    "field extra in SDK (this call site sends or reads it, but the reference does not have it)",
  required: "required mismatch",
  type: "type mismatch",
};

/**
 * Field findings for one called operation across its call sites. An
 * unresolvable finding goes to `warnings`, never to `problems`.
 */
function checkFields(spec, checker, { plane, op, sites }) {
  const [method, path] = op.split(" ");
  const shapes = specShapes(spec, path, method, CLIENT);
  const title = `${PLANE_NAMES[plane]}: ${op}`;
  const problems = [];
  const warnings = [];
  let count = 0;

  for (const { at, site } of sites) {
    const findings = compareCallSite(
      spec,
      checker,
      shapes,
      callSiteTypes(checker, site),
    );
    const groups = new Map();
    for (const f of findings) {
      if (f.kind === "unresolvable") {
        warnings.push({ title, field: f.field, detail: f.detail, at });
        continue;
      }
      count += 1;
      if (!groups.has(f.kind)) groups.set(f.kind, []);
      groups.get(f.kind).push(f.detail ? `${f.field} (${f.detail})` : f.field);
    }
    if (groups.size)
      problems.push(
        `  ${at}\n${[...groups]
          .map(
            ([kind, fields]) =>
              `    ${FINDING_MEANS[kind]}:${listing(fields).replaceAll("\n      ", "\n        ")}`,
          )
          .join("\n")}`,
      );
  }

  return {
    problems: problems.length
      ? [`fields — ${title}\n${problems.join("\n")}`]
      : [],
    count,
    warnings,
  };
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

async function main() {
  // The two planes are separate services with separate references. The
  // control-plane half went unchecked entirely until an experiments filter
  // the API does not accept shipped in two SDKs at once.
  const sources = {};
  const specs = {};
  for (const [plane, name] of Object.entries(PLANE_NAMES)) {
    sources[plane] = referenceSource(name);
    try {
      specs[plane] = await loadSpec(sources[plane]);
    } catch (error) {
      console.error(
        `could not read the API reference at ${sources[plane]}: ${error.message}`,
      );
      return 1;
    }
  }

  const files = sourceFiles(PACKAGES);
  const program = createProgram(ROOT, files);
  const checker = program.getTypeChecker();
  const { calls, unknownMethod } = sdkCalls(program, files);

  const operations = checkOperations(specs, calls, unknownMethod);
  const problems = [...operations.problems];
  const warnings = [];
  let fieldFindings = 0;
  for (const operation of operations.calledOperations) {
    const fields = checkFields(specs[operation.plane], checker, operation);
    problems.push(...fields.problems);
    warnings.push(...fields.warnings);
    fieldFindings += fields.count;
  }

  // Printed whatever the outcome, and never part of it: the checker cannot
  // compare these call sites, which is a gap in the SDK's types rather than
  // drift in the API.
  if (warnings.length) {
    const byOperation = Map.groupBy(warnings, (w) => w.title);
    console.log(
      `Warning: SDK has no concrete types (does not fail; give these call sites concrete types so their fields are checked)\n${[
        ...byOperation,
      ]
        .map(
          ([title, items]) =>
            `  ${title}\n${items.map((w) => `    ${w.field}${w.detail ? `: ${w.detail}` : ""} (${w.at})`).join("\n")}`,
        )
        .join("\n")}\n`,
    );
  }

  const summary = [
    `${operations.missing} ${CLIENT} operations not called`,
    `${operations.notInReference} routes not in the reference`,
    `${operations.unmatched} unmatched routes`,
    `${fieldFindings} field findings`,
    `${warnings.length} call-site warnings`,
  ].join(", ");
  if (problems.length) {
    console.error(problems.join("\n\n"));
    console.error(`\nsummary: ${summary}`);
    console.error(`reference: ${sources.dp} + ${sources.cp}`);
    return 1;
  }

  console.log(
    `✓ SDK surface matches the reference (${operations.count} operations, ${operations.calledOperations.length} field-checked, ${warnings.length} call-site warnings)`,
  );
  return 0;
}

process.exit(await main());
