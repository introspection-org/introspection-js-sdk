/**
 * Compares the routes this SDK calls with the API reference.
 *
 * The references are the OpenAPI documents each plane serves at
 * `/openapi.json`, generated from the APIs themselves. They also say who each
 * route is for: an operation without `x-introspection` is for every client;
 * one with `x-introspection: { clients: [...] }` is for the clients it lists,
 * and `clients: []` for none. Routes no client may call are not in them at
 * all. That classification is the only one; this check keeps no list of its
 * own, and compares routes only (method and path, not query parameters).
 *
 * It fails when:
 *
 * - an operation for every client, or whose `x-introspection.clients`
 *   includes "sdk", is sent from no call site in each package's `src`;
 * - a call site sends a `/v1/...` route that neither reference has.
 *
 * Field changes are not compared.
 *
 * With `--pr`, the first kind is only reported and does not fail: a new cloud
 * route must not block unrelated pull requests. ci.yml runs it so on every
 * pull request; .github/workflows/api-contract.yml runs it in full after each
 * staging deploy and posts state changes to #main-build-alerts.
 *
 * Exit 1 is drift, 2 a reference that could not be read (any HTTP error,
 * including 404, a network failure or a body that is not JSON) or a plane
 * URL that is not set. Only a run that read both references writes `--out`,
 * so a failed read changes no recorded state and posts nothing.
 *
 * Run: INTROSPECTION_CP_URL=<control plane base URL> \
 *      INTROSPECTION_DP_URL=<data plane base URL> \
 *        node scripts/check-api-contract.mjs
 *        [--pr] [--out DIR] [--dataplane URL|PATH] [--controlplane URL|PATH]
 *      --out DIR  also writes the findings to DIR/report.txt and red|green to
 *                 DIR/state
 * env: API_CONTRACT_DATAPLANE, API_CONTRACT_CONTROLPLANE  the same, for a flag
 *      left out
 *      INTROSPECTION_CP_URL, INTROSPECTION_DP_URL  each plane's base URL,
 *          whose /openapi.json is its reference when neither of the above
 *          names one. CI takes them from introspection-cloud's
 *          api-reference-deployed event (scripts/api-reference-urls.sh).
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The client name this SDK goes by in `x-introspection.clients`. */
const CLIENT = "sdk";

const PACKAGES = resolve(ROOT, "packages");
const PLANE_NAMES = { dp: "dataplane", cp: "controlplane" };
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];
/** Helpers that take a route as an argument and always send it as a GET. */
const GET_HELPERS = new Set(["paginateGet", "listRead", "arrowRead"]);
/** Direct fetch calls, such as the OAuth routes that bypass the HTTP client. */
const FETCH_CALLEES = new Set(["fetch", "fetchImpl"]);

function arg(name) {
  const flag = process.argv.indexOf(name);
  return flag === -1 ? undefined : process.argv[flag + 1];
}

/** The variable holding each plane's base URL; neither has a fixed host. */
const BASE_URL_VARS = {
  controlplane: "INTROSPECTION_CP_URL",
  dataplane: "INTROSPECTION_DP_URL",
};

/** Each plane's base URL; a missing one throws. */
function baseUrl(plane) {
  const name = BASE_URL_VARS[plane];
  const base = process.env[name]?.trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      `${name} is not set: set it to the staging ${plane}'s base URL, or pass --${plane}`,
    );
  }
  return base;
}

/** `--<plane>`, else `API_CONTRACT_<PLANE>`, else the base URL's `/openapi.json`. */
const referenceSource = (plane) =>
  arg(`--${plane}`) ||
  process.env[`API_CONTRACT_${plane.toUpperCase()}`] ||
  `${baseUrl(plane)}/openapi.json`;

const listing = (items) =>
  [...items]
    .sort()
    .map((item) => `\n      ${item}`)
    .join("");

/** Path parameters compare by position, not by name. */
const templateKey = (path) => path.replace(/\{[^}]*\}/g, "{}");

/** Each package's `src`, walked on its own so no `node_modules` is listed. */
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(dir, entry.name, "src"))
    .filter((src) => existsSync(src))
    .flatMap((src) =>
      readdirSync(src, { recursive: true })
        .filter((f) => f.endsWith(".ts"))
        .filter((f) => !f.endsWith(".d.ts") && !f.endsWith(".test.ts"))
        .filter((f) => !f.split("/").includes("node_modules"))
        .map((f) => resolve(src, f)),
    );
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
 * Every route this SDK sends, as `{ method, path, at }`. A route is sent where
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
          if (method) calls.push({ method, path, at: at(input) });
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
 * and the clients its `x-introspection` names (undefined without one: every
 * client), plus the operations that
 * share a `<METHOD> /v1/<template>` (path parameters by position) with
 * another, in either reference: a call site cannot tell them apart.
 */
function specOperations(specs) {
  const operations = new Map();
  const inBoth = [];
  const templates = new Map();
  for (const [plane, spec] of Object.entries(specs)) {
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const method of HTTP_METHODS) {
        const op = item[method];
        if (!op) continue;
        const key = `${method.toUpperCase()} ${path}`;
        const template = `${method.toUpperCase()} ${templateKey(path)}`;
        // Call sites only send `/v1/` routes, so only those can be ambiguous;
        // both planes serve their own `/health` and `/ready`.
        if (path.startsWith("/v1/")) {
          if (templates.has(template))
            inBoth.push(`${templates.get(template)} and ${key}`);
          else templates.set(template, key);
        }
        operations.set(key, {
          plane,
          clients: op["x-introspection"]?.clients,
        });
      }
    }
  }
  return { operations, inBoth };
}

/** The reference's classification against the call sites. */
function checkOperations(specs, calls, unknownMethod) {
  const { operations, inBoth } = specOperations(specs);

  // The spec operation each normalized `<METHOD> <template>` names.
  const byKey = new Map();
  for (const op of operations.keys()) {
    const [method, path] = op.split(" ");
    byKey.set(`${method} ${templateKey(path)}`, op);
  }

  const called = new Set();
  const notInReference = [];
  for (const call of calls) {
    const op = byKey.get(`${call.method} ${templateKey(call.path)}`);
    if (!op) {
      notInReference.push(`${call.method} ${call.path} (${call.at})`);
      continue;
    }
    called.add(op);
  }

  const uncalled = [];
  for (const [op, { plane, clients }] of operations) {
    if ((!clients || clients.includes(CLIENT)) && !called.has(op))
      uncalled.push(`${PLANE_NAMES[plane]}: ${op}`);
  }

  // Uncalled operations are reported first; `--pr` reports them without
  // failing.
  const problems = [];
  const report = (items, means, fails = true) => {
    if (items.length)
      problems.push({
        fails,
        text: `operations — ${means} (${items.length}):${listing(items)}`,
      });
  };
  report(
    uncalled,
    `for every client (no x-introspection) or "${CLIENT}" in x-introspection.clients, but no call site in packages/*/src sends it`,
    !process.argv.includes("--pr"),
  );
  report(
    notInReference,
    "called by this SDK but not in either reference (the SDK calls a route that does not exist)",
  );
  report(
    inBoth,
    "declared twice with the same method and path template, so a call site cannot be matched to one",
  );
  report(
    unknownMethod,
    "a route sent without a literal `method`, so it cannot be matched",
  );
  return {
    problems,
    count: operations.size,
    missing: uncalled.length,
    notInReference: notInReference.length,
    unmatched: inBoth.length + unknownMethod.length,
  };
}

/** The reference as JSON; any HTTP error, 404 included, throws. */
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
    try {
      sources[plane] = referenceSource(name);
    } catch (error) {
      console.error(error.message);
      return 2;
    }
    try {
      specs[plane] = await loadSpec(sources[plane]);
    } catch (error) {
      console.error(
        `could not read the API reference at ${sources[plane]}: ${error.message}`,
      );
      return 2;
    }
  }

  const files = sourceFiles(PACKAGES);
  // Only the checker's local symbols are needed, to tell same-named route
  // aliases apart, so nothing is resolved beyond the files themselves.
  const program = ts.createProgram(files, { noResolve: true, noLib: true });
  const { calls, unknownMethod } = sdkCalls(program, files);
  const operations = checkOperations(specs, calls, unknownMethod);

  const summary = [
    `${operations.missing} ${CLIENT} operations not called`,
    `${operations.notInReference} routes not in the reference`,
    `${operations.unmatched} unmatched routes`,
  ].join(", ");
  const fails = operations.problems.some((problem) => problem.fails);
  const report = operations.problems.length
    ? [
        ...operations.problems.map((problem) => problem.text),
        `summary: ${summary}\nreference: ${sources.dp} + ${sources.cp}`,
      ].join("\n\n")
    : `✓ SDK routes match the reference (${operations.count} operations)`;
  console.log(report);

  const out = arg("--out");
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(resolve(out, "report.txt"), `${report}\n`);
    writeFileSync(resolve(out, "state"), fails ? "red\n" : "green\n");
  }
  return fails ? 1 : 0;
}

process.exit(await main());
