/**
 * Compares this SDK's request/response surface against the published API reference.
 *
 * `mode` and `system_id` sat on `TaskCreateParams` for the entire life of their
 * retirement, `Task.mode` described a field the API had stopped returning, and
 * `TaskListParams.modes` was a filter the API never had. None of it failed:
 * TypeScript erases at runtime, so the types lied rather than broke, and
 * nothing in CI knew what the API accepted.
 *
 * That create body is not field-checked today: `TasksClient.create` sends
 * `mapTaskBody(body)`, which returns `Record<string, unknown>`, so its call
 * site is printed as a warning ("SDK has no concrete types") by name until it
 * is given a concrete wire type. It does not yet catch that kind of drift
 * field by field.
 *
 * The reference at docs.introspection.dev is generated from the Data Plane API
 * itself, so comparing against it compares against the API's own declaration
 * rather than a second hand-maintained copy.
 *
 * Every operation in both references must be classified in
 * scripts/api-contract/operations.json as called by this SDK ("sdk") or
 * excluded with a reason, and the classification must agree with the route
 * literals in each package's `src` (see "operations" below).
 *
 * For every "sdk" operation, each call site's request body, query parameters
 * and response are compared field by field with the operation's schemas in
 * the reference (see api-contract/fields.mjs). Types have no runtime
 * representation to reflect over, so they are read with the TypeScript
 * checker at the call site itself: the type that actually goes on the wire,
 * inherited members and nested `$ref` schemas included. An exemption sits in
 * operations.json under its operation, with a reason; one that holds for every
 * operation of a plane sits once under `shared` (see "shared exemptions").
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
 *
 * Run: node scripts/check-api-contract.mjs [--spec URL|PATH] [--cp-spec URL|PATH]
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SPEC = "https://docs.introspection.dev/openapi/dataplane.json";
const DEFAULT_CP_SPEC =
  "https://docs.introspection.dev/openapi/controlplane.json";

// --- operations -------------------------------------------------------------
// A field check over routes someone thought to list leaves a route nobody
// listed invisible: a whole resource could ship, drift or disappear with
// nothing here noticing. So every operation in both references is classified
// in operations.json, either as called by this SDK or as excluded with a
// reason, and the classification is checked against the call sites.

const OPERATIONS = resolve(ROOT, "scripts/api-contract/operations.json");
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
      const routes = routesOf(node.initializer, aliases);
      if (routes.length) routesBySymbol.set(symbolOf(node.name), routes);
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

const isSdk = (entry) => entry === "sdk" || entry?.sdk === true;

/** Problems with an `{ "sdk": true, "exempt": [...] }` entry's shape. */
function entryShapeProblems(entry) {
  if (entry === "sdk") return [];
  if (entry?.sdk !== true) {
    return typeof entry?.excluded === "string" && entry.excluded.trim()
      ? []
      : [
          'must be "sdk", { "sdk": true, "exempt": [...] } or { "excluded": "<reason>" }',
        ];
  }
  return (entry.exempt ?? []).flatMap((ex, i) => {
    const kinds = ["missing", "extra"].filter(
      (k) => typeof ex?.[k] === "string",
    );
    const ok =
      kinds.length === 1 &&
      typeof ex.reason === "string" &&
      ex.reason.trim() &&
      (ex.at === undefined || typeof ex.at === "string") &&
      (ex.report === undefined || typeof ex.report === "boolean");
    return ok
      ? []
      : [
          `exempt[${i}] must be { "missing" | "extra": "<field>", "reason": "<why>", "at"?: "<file>", "report"?: true }`,
        ];
  });
}

// --- shared exemptions ------------------------------------------------------
// Some query parameters exist on every route of a plane for reasons that are
// not SDK surface, such as the Data Plane's `lane` (the session-lane
// selector) and `project_id` (a privileged project override). Listing them
// under each operation would repeat one decision on every route and miss the
// next route that gains them, so they sit once under `shared.<plane>` in
// operations.json, as `{ "missing" | "extra": "<field>", "reason": "<why>" }`.
// A finding a shared exemption covers is dropped, not reported. A shared
// exemption no call site of its plane needs fails as stale, unless a call
// site that could need it is unresolvable (a warning never fails the run).

/** The `shared` exemptions by plane name, plus problems with their shape. */
function sharedExemptions(classified) {
  const problems = [];
  const shared = {};
  const planes = Object.values(PLANE_NAMES);
  for (const [name, rules] of Object.entries(classified.shared ?? {})) {
    if (!planes.includes(name) || !Array.isArray(rules)) {
      problems.push(
        `operations.json — shared.${name} must be a list under one of: ${planes.join(", ")}`,
      );
      continue;
    }
    shared[name] = [];
    rules.forEach((rule, i) => {
      const kinds = ["missing", "extra"].filter(
        (k) => typeof rule?.[k] === "string",
      );
      const keys = Object.keys(rule ?? {});
      if (
        kinds.length !== 1 ||
        typeof rule.reason !== "string" ||
        !rule.reason.trim() ||
        keys.some((k) => ![...kinds, "reason"].includes(k))
      ) {
        problems.push(
          `operations.json — shared.${name}[${i}] must be { "missing" | "extra": "<field>", "reason": "<why>" }`,
        );
        return;
      }
      shared[name].push({
        field: rule[kinds[0]],
        kind: kinds[0],
        undecided: false,
        used: false,
      });
    });
  }
  return { problems, shared };
}

/** Operation-level findings: classification against call sites. */
function checkOperations(specs, calls, unknownMethod) {
  const classified = JSON.parse(readFileSync(OPERATIONS, "utf8"));
  const { problems, shared } = sharedExemptions(classified);
  const operations = specOperations(specs);

  // The spec operation each normalized `<METHOD> <template>` names.
  const byKey = new Map();
  for (const op of operations.keys()) {
    const [method, path] = op.split(" ");
    byKey.set(`${method} ${templateKey(path)}`, op);
  }

  const called = new Map();
  const dead = [];
  for (const call of calls) {
    const op = byKey.get(`${call.method} ${templateKey(call.path)}`);
    if (!op) {
      dead.push(`${call.method} ${call.path} (${call.at})`);
      continue;
    }
    if (!called.has(op)) called.set(op, []);
    if (!called.get(op).some((c) => c.at === call.at))
      called.get(op).push(call);
  }

  const unclassified = [];
  const stale = [];
  const sdkUncalled = [];
  const excludedCalled = [];
  const sdkOperations = [];
  for (const [plane, name] of Object.entries(PLANE_NAMES)) {
    const entries = classified[name] ?? {};
    for (const [op, opPlane] of operations) {
      if (opPlane === plane && !(op in entries))
        unclassified.push(`${name}: ${op}`);
    }
    for (const [op, entry] of Object.entries(entries)) {
      const shape = entryShapeProblems(entry);
      if (operations.get(op) !== plane) {
        stale.push(`${name}: ${op}`);
      } else if (shape.length) {
        problems.push(`operations.json — ${name}: ${op}${listing(shape)}`);
      } else if (isSdk(entry)) {
        if (!called.has(op)) sdkUncalled.push(`${name}: ${op}`);
        else
          sdkOperations.push({ plane, name, op, entry, sites: called.get(op) });
      } else if (called.has(op)) {
        const at = called.get(op).map((c) => c.at);
        excludedCalled.push(`${name}: ${op} (${at.join(", ")})`);
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

  return { problems, count: operations.size, sdkOperations, shared };
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

/** `body`, `query` or `response`: where a field path starts. */
const fieldRoot = (field) => field.split(/[.[(]/)[0];

/**
 * Whether the reference can hold a field at this operation: a query
 * parameter (or, for `query.*`, any) it declares. Any other path counts as
 * declared, since only the query's parameters are known without the types.
 */
function declares(shapes, field) {
  const query = /^query\.([^.[(]+)$/.exec(field)?.[1];
  if (!query) return true;
  const params = Object.keys(shapes.query.properties);
  return query === "*" ? params.length > 0 : params.includes(query);
}

/** An exemption's field is exact, or `<parent>.*` for any direct child. */
function fieldMatches(pattern, field) {
  if (!pattern.endsWith(".*")) return pattern === field;
  const parent = pattern.slice(0, -1);
  return field.startsWith(parent) && !/[.[(]/.test(field.slice(parent.length));
}

/**
 * Field findings for one "sdk" operation across its call sites, with the
 * entry's exemptions applied. An exemption that no resolvable call site in
 * its scope needs any more is stale: it would otherwise stay quietly true
 * forever, hiding nothing.
 *
 * `shared` is the plane's shared exemptions, applied before the entry's own.
 * An unresolvable finding goes to `warnings`, never to `problems`.
 */
function checkFields(spec, checker, { name, op, entry, sites }, shared = []) {
  const [method, path] = op.split(" ");
  const shapes = specShapes(spec, path, method);
  const exemptions = (entry.exempt ?? []).map((ex) => ({
    ...ex,
    field: ex.missing ?? ex.extra,
    kind: ex.missing !== undefined ? "missing" : "extra",
    judged: false,
    used: false,
  }));
  const problems = [];
  const notes = [];
  const warnings = [];

  for (const { at, site } of sites) {
    const file = at.replace(/:\d+$/, "");
    const findings = compareCallSite(
      spec,
      checker,
      shapes,
      callSiteTypes(checker, site),
    );
    const unresolved = new Set(
      findings
        .filter((f) => f.kind === "unresolvable")
        .map((f) => fieldRoot(f.field)),
    );
    const inScope = exemptions.filter((ex) => !ex.at || ex.at === file);
    for (const ex of inScope) {
      if (!unresolved.has(fieldRoot(ex.field))) ex.judged = true;
    }
    // A shared rule spans every route of the plane, so one route that could
    // need it and cannot be read leaves it undecided: were it stale, the
    // only routes that still need it might be the unresolvable ones.
    for (const e of shared) {
      if (
        unresolved.has(fieldRoot(e.field)) &&
        (e.kind === "extra" || declares(shapes, e.field))
      )
        e.undecided = true;
    }

    const fatal = new Map();
    const noted = new Map();
    for (const f of findings) {
      if (f.kind === "unresolvable") {
        warnings.push({
          title: `${name}: ${op}`,
          field: f.field,
          detail: f.detail,
          at,
        });
        continue;
      }
      const sharedCovering = shared.filter(
        (e) => e.kind === f.kind && fieldMatches(e.field, f.field),
      );
      for (const e of sharedCovering) e.used = true;
      if (sharedCovering.length) continue;
      // Every exemption that covers the finding is in use, whatever its
      // order: an exact one next to an overlapping `<parent>.*` is not
      // stale. One that silences wins over a report-only one.
      const covering = inScope.filter(
        (e) => e.kind === f.kind && fieldMatches(e.field, f.field),
      );
      for (const e of covering) e.used = true;
      const into = !covering.length
        ? fatal
        : covering.every((e) => e.report)
          ? noted
          : null;
      if (!into) continue;
      if (!into.has(f.kind)) into.set(f.kind, []);
      into.get(f.kind).push(f.detail ? `${f.field} (${f.detail})` : f.field);
    }
    const describe = (groups) =>
      [...groups]
        .map(
          ([kind, fields]) =>
            `    ${FINDING_MEANS[kind]}:${listing(fields).replaceAll("\n      ", "\n        ")}`,
        )
        .join("\n");
    if (fatal.size) problems.push(`  ${at}\n${describe(fatal)}`);
    if (noted.size) notes.push(`  ${at}\n${describe(noted)}`);
  }

  const describeExemption = (ex) =>
    `${ex.kind} ${ex.field}${ex.at ? ` (${ex.at})` : ""}`;
  const stale = exemptions
    .filter((ex) => ex.judged && !ex.used)
    .map(describeExemption);
  if (stale.length)
    problems.push(
      `  exempted in operations.json but no call site needs it any more (drop the exemption):${listing(stale)}`,
    );
  // Scoped to a file with no call site: never judged, so it would otherwise
  // stay forever without anyone seeing it.
  const files = new Set(sites.map(({ at }) => at.replace(/:\d+$/, "")));
  const orphaned = exemptions
    .filter((ex) => ex.at && !files.has(ex.at))
    .map(describeExemption);
  if (orphaned.length)
    problems.push(
      `  exempted in operations.json at a file with no call site of this operation (fix \`at\` or drop the exemption):${listing(orphaned)}`,
    );

  const title = `fields — ${name}: ${op}`;
  return {
    problems: problems.length ? [`${title}\n${problems.join("\n")}`] : [],
    notes: notes.length
      ? [`note: ${title} (exempted, reported only)\n${notes.join("\n")}\n`]
      : [],
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

  const files = sourceFiles(PACKAGES);
  const program = createProgram(ROOT, files);
  const checker = program.getTypeChecker();
  const { calls, unknownMethod } = sdkCalls(program, files);

  const operations = checkOperations(specs, calls, unknownMethod);
  const problems = [...operations.problems];
  const warnings = [];
  for (const operation of operations.sdkOperations) {
    const fields = checkFields(
      specs[operation.plane],
      checker,
      operation,
      operations.shared[operation.name],
    );
    problems.push(...fields.problems);
    warnings.push(...fields.warnings);
    for (const note of fields.notes) console.log(note);
  }
  const staleShared = Object.entries(operations.shared).flatMap(
    ([name, rules]) =>
      rules
        .filter((rule) => !rule.used && !rule.undecided)
        .map((rule) => `shared.${name}: ${rule.kind} ${rule.field}`),
  );
  if (staleShared.length)
    problems.push(
      `operations.json — shared exemption no call site needs any more (drop it):${listing(staleShared)}`,
    );

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

  if (problems.length) {
    console.error(problems.join("\n\n"));
    console.error(`\nreference: ${specSource} + ${cpSpecSource}`);
    return 1;
  }

  console.log(
    `✓ SDK surface matches the published reference (${operations.count} operations, ${operations.sdkOperations.length} field-checked${warnings.length ? `, ${warnings.length} call-site warnings` : ""})`,
  );
  return 0;
}

process.exit(await main());
