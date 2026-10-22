/**
 * Per-operation field check: the request body, query parameters and response
 * an SDK call site sends and reads, compared with the operation's schemas in
 * the API reference.
 *
 * The SDK side comes from the TypeScript checker at the call site itself, not
 * from a hand-picked interface: what `body:` evaluates to, what `query:` (or
 * the params handed to a pagination helper) evaluates to, and what the call
 * resolves to. A hand-listed interface checks the type someone thought the
 * route used; the call site is the type the route actually gets.
 *
 * Where the checker cannot say what goes on the wire (a generic, a body
 * mapped to `Record<string, unknown>`, a body serialized before the call, an
 * untyped or `Record` field nested in a typed one), the call site is reported
 * as unresolvable rather than skipped. A check that passes because it
 * compared nothing teaches the reader that green means checked.
 *
 * A form body that `fetch` encodes itself (`FormData`, `URLSearchParams`) is
 * compared by media type only: it carries no field types, like a non-JSON
 * response.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";

/**
 * A program over every package's `src`, with each workspace package name
 * mapped to its source entry. CI never builds the packages, so resolving
 * `@introspection-sdk/types` through `dist/` would find nothing.
 */
export function createProgram(root, files) {
  const packages = resolve(root, "packages");
  const paths = {};
  for (const dir of readdirSync(packages)) {
    let manifest;
    try {
      manifest = JSON.parse(
        readFileSync(resolve(packages, dir, "package.json"), "utf8"),
      );
    } catch {
      continue;
    }
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const types = typeof target === "string" ? target : target?.types;
      if (!types?.startsWith("./dist/")) continue;
      const source = types
        .replace(/^\.\/dist\//, "src/")
        .replace(/\.d\.ts$/, ".ts");
      paths[manifest.name + subpath.slice(1)] = [
        resolve(packages, dir, source),
      ];
    }
  }
  return ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    paths,
  });
}

// --- the reference side ------------------------------------------------------

function deref(spec, schema) {
  let ref;
  const seen = new Set();
  while (schema?.$ref && !seen.has(schema.$ref)) {
    seen.add(schema.$ref);
    ref = schema.$ref.split("/").pop();
    schema = spec.components?.schemas?.[ref];
  }
  if (schema?.allOf?.length === 1) return deref(spec, schema.allOf[0]);
  return { schema: schema ?? {}, ref };
}

/**
 * The branches of a schema with `null` dropped, each dereferenced. `origin`
 * is the schema object a branch came from, so a branch rebuilt for one entry
 * of a `type` list keeps the identity recursion detection keys on.
 */
function branches(spec, schema) {
  const { schema: s, ref } = deref(spec, schema);
  const alternatives = s.anyOf ?? s.oneOf;
  if (alternatives) {
    return alternatives
      .flatMap((alt) => branches(spec, alt))
      .map((b) => ({
        ...b,
        discriminator: s.discriminator ?? b.discriminator,
      }));
  }
  if (Array.isArray(s.type)) {
    return s.type
      .filter((t) => t !== "null")
      .map((type) => ({ schema: { ...s, type }, ref, origin: s }));
  }
  if (s.type === "null") return [];
  return [{ schema: s, ref, origin: s }];
}

function specKind(schema) {
  if (schema.type === "integer" || schema.type === "number") return "number";
  if (schema.type) return schema.type;
  if (schema.properties || schema.additionalProperties) return "object";
  const values = schema.enum ?? ("const" in schema ? [schema.const] : null);
  if (values?.length) return typeof values[0];
  return "any";
}

// --- the SDK side ------------------------------------------------------------

const NULLISH = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void;
/** A type that still depends on a type parameter, such as `EventForName<N>`. */
const GENERIC =
  ts.TypeFlags.TypeParameter |
  ts.TypeFlags.Conditional |
  ts.TypeFlags.IndexedAccess |
  ts.TypeFlags.Substitution |
  ts.TypeFlags.Index;

const members = (type) =>
  (type.isUnion() ? type.types : [type]).filter((t) => !(t.flags & NULLISH));

function tsKind(checker, type) {
  const f = type.flags;
  if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "any";
  if (f & GENERIC) return "generic";
  if (f & ts.TypeFlags.StringLike) return "string";
  if (f & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) return "number";
  if (f & ts.TypeFlags.BooleanLike) return "boolean";
  if (type.isIntersection()) {
    // `string & Record<never, never>`, the open-string-union idiom.
    const primitive = type.types
      .map((t) => tsKind(checker, t))
      .find((k) => k !== "object");
    return primitive ?? "object";
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) return "array";
  if (f & ts.TypeFlags.Object || f & ts.TypeFlags.NonPrimitive) return "object";
  return "any";
}

/** True when the type, or any part of it, is still a type parameter. */
function isGeneric(checker, type, seen = new Set()) {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.flags & GENERIC) return true;
  if (type.isUnionOrIntersection())
    return type.types.some((t) => isGeneric(checker, t, seen));
  if (
    type.flags & ts.TypeFlags.Object &&
    type.objectFlags & ts.ObjectFlags.Reference
  )
    return checker
      .getTypeArguments(type)
      .some((t) => isGeneric(checker, t, seen));
  return false;
}

const hasNoProperties = (checker, type) =>
  tsKind(checker, type) === "object" &&
  !checker.isArrayType(type) &&
  checker.getPropertiesOfType(type).length === 0;

/** An object with keys but no named ones, such as `Record<string, unknown>`. */
const isOpaqueObject = (checker, type) =>
  hasNoProperties(checker, type) &&
  checker.getIndexInfosOfType(type).length > 0;

/** `{}`: an object that sends no fields at all. */
const isEmptyObject = (checker, type) =>
  members(type).every(
    (t) => hasNoProperties(checker, t) && !isOpaqueObject(checker, t),
  );

/**
 * Why a top-level body, query or response type cannot be compared, or
 * undefined when it can.
 */
function unresolvable(checker, type) {
  const parts = members(type);
  if (!parts.length) return undefined;
  if (isGeneric(checker, type))
    return `generic (${checker.typeToString(type)})`;
  if (parts.every((t) => tsKind(checker, t) === "any"))
    return `untyped (${checker.typeToString(type)})`;
  if (parts.every((t) => tsKind(checker, t) === "string"))
    return "serialized before the call (string)";
  if (parts.every((t) => isOpaqueObject(checker, t)))
    return `no named fields (${checker.typeToString(type)})`;
  return undefined;
}

const elementTypes = (checker, types) =>
  types
    .filter((t) => checker.isArrayType(t) || checker.isTupleType(t))
    .flatMap((t) => checker.getTypeArguments(t));

/** `name -> { optional, types }` across the object members of a type. */
function tsProperties(checker, objects) {
  const props = new Map();
  for (const obj of objects) {
    for (const sym of checker.getPropertiesOfType(obj)) {
      const prop = props.get(sym.name) ?? {
        optional: false,
        types: [],
        count: 0,
      };
      prop.count += 1;
      if (sym.flags & ts.SymbolFlags.Optional) prop.optional = true;
      prop.types.push(checker.getTypeOfSymbol(sym));
      props.set(sym.name, prop);
    }
  }
  for (const prop of props.values()) {
    if (prop.count < objects.length) prop.optional = true;
  }
  return props;
}

/** The literal values a discriminator property can take on one member. */
function literalValues(checker, obj, name) {
  const sym = checker.getPropertyOfType(obj, name);
  if (!sym) return [];
  const type = checker.getTypeOfSymbol(sym);
  const parts = type.isUnion() ? type.types : [type];
  return parts.every((t) => t.isStringLiteral())
    ? parts.map((t) => t.value)
    : [];
}

// --- comparison --------------------------------------------------------------

const describeKinds = (kinds) => [...kinds].sort().join(" | ");

/**
 * A number per object, for keys that must tell apart two schemas or types
 * that print the same: two inline object schemas (no `$ref`), or two types
 * whose `typeToString` collides.
 */
const identities = new WeakMap();
let nextIdentity = 0;
const identity = (obj) => {
  if (!identities.has(obj)) identities.set(obj, ++nextIdentity);
  return identities.get(obj);
};

/**
 * Compare a reference schema with an SDK type, appending findings
 * `{ kind, field, detail }` to `out`.
 *
 * Nullability is not compared: the reference writes an optional field as
 * `anyOf: [T, null]` throughout, so it would flag nearly every field.
 *
 * `repeatable` marks a query parameter: a query string repeats a key for a
 * list, so one scalar value is a list of one and matches an array parameter.
 */
function compare(ctx, schema, type, field, out, repeatable = false) {
  const { spec, checker, seen } = ctx;
  const specBranches = branches(spec, schema);
  const tsTypes = Array.isArray(type) ? type.flatMap(members) : members(type);
  if (!specBranches.length || !tsTypes.length) return;

  const specKinds = new Set(specBranches.map((b) => specKind(b.schema)));
  const sdkKinds = new Set(tsTypes.map((t) => tsKind(checker, t)));
  if (specKinds.has("any")) return;
  // Below the top level as at it: a field the SDK leaves untyped or generic
  // compares nothing, so it is named rather than passed.
  if (sdkKinds.has("any")) {
    out.push({ kind: "unresolvable", field, detail: "untyped" });
    return;
  }
  if (sdkKinds.has("generic")) {
    out.push({ kind: "unresolvable", field, detail: "generic" });
    return;
  }
  if (repeatable && specKinds.has("array") && !sdkKinds.has("array")) {
    const items = specBranches.find((b) => specKind(b.schema) === "array")
      ?.schema.items;
    if (items) return compare(ctx, items, tsTypes, field, out);
  }
  if (![...specKinds].some((k) => sdkKinds.has(k))) {
    out.push({
      kind: "type",
      field,
      detail: `reference ${describeKinds(specKinds)}, SDK ${describeKinds(sdkKinds)}`,
    });
    return;
  }

  if (specKinds.has("array") && sdkKinds.has("array")) {
    const items = specBranches
      .filter((b) => specKind(b.schema) === "array" && b.schema.items)
      .map((b) => b.schema.items);
    if (items.length === 1)
      compare(ctx, items[0], elementTypes(checker, tsTypes), `${field}[]`, out);
  }

  if (!(specKinds.has("object") && sdkKinds.has("object"))) return;
  const specObjects = specBranches.filter(
    (b) => specKind(b.schema) === "object" && b.schema.properties,
  );
  const tsObjects = tsTypes.filter(
    (t) => tsKind(checker, t) === "object" && !isOpaqueObject(checker, t),
  );
  if (!specObjects.length) return;
  if (!tsObjects.length) {
    // The reference names fields the SDK types as `Record<string, ...>`.
    if (tsTypes.some((t) => isOpaqueObject(checker, t)))
      out.push({ kind: "unresolvable", field, detail: "no named fields" });
    return;
  }

  // Keyed by identity, not by name: inline schemas have no `$ref`, so a key
  // of refs and printed types would let an unrelated pair skip its check.
  const key = `${specObjects.map((b) => identity(b.origin)).join("|")}::${tsObjects.map(identity).join("|")}`;
  if (seen.has(key)) return;
  seen.add(key);

  const discriminator = specObjects[0].discriminator;
  if (specObjects.length > 1 && discriminator?.propertyName) {
    compareVariants(
      ctx,
      specObjects,
      tsObjects,
      discriminator.propertyName,
      field,
      out,
    );
    return;
  }
  compareObjects(ctx, specObjects, tsObjects, field, out);
}

/** A discriminated union, paired by discriminator value. */
function compareVariants(ctx, specObjects, tsObjects, name, field, out) {
  const { checker } = ctx;
  const specByValue = new Map();
  for (const b of specObjects) {
    const value = branches(ctx.spec, b.schema.properties?.[name] ?? {}).flatMap(
      (p) => p.schema.enum ?? ("const" in p.schema ? [p.schema.const] : []),
    );
    for (const v of value) specByValue.set(v, b);
  }
  const tsByValue = new Map();
  for (const t of tsObjects) {
    for (const v of literalValues(checker, t, name)) tsByValue.set(v, t);
  }
  const at = (v) => `${field}(${name}=${v})`;
  for (const [value, b] of specByValue) {
    const t = tsByValue.get(value);
    if (!t) out.push({ kind: "missing", field: at(value), detail: "variant" });
    else compareObjects(ctx, [b], [t], at(value), out);
  }
  for (const value of tsByValue.keys()) {
    if (!specByValue.has(value))
      out.push({ kind: "extra", field: at(value), detail: "variant" });
  }
}

/**
 * Field names, then required-ness, then each shared field recursively. Only
 * "required in the reference, optional in the SDK" is a required mismatch:
 * a call site that always sends a field the reference makes optional is
 * fine, and a response field the reference marks optional is still always
 * serialized (it marks every field with a default as optional).
 */
function compareObjects(ctx, specObjects, tsObjects, field, out) {
  const { checker } = ctx;
  const specProps = new Map();
  const required = new Set(specObjects[0].schema.required ?? []);
  for (const b of specObjects) {
    for (const [name, prop] of Object.entries(b.schema.properties)) {
      if (!specProps.has(name)) specProps.set(name, prop);
    }
    for (const name of required) {
      if (!(b.schema.required ?? []).includes(name)) required.delete(name);
    }
  }
  const sdkProps = tsProperties(checker, tsObjects);
  const child = (name) => (field ? `${field}.${name}` : name);

  for (const [name, prop] of specProps) {
    const sdk = sdkProps.get(name);
    if (!sdk) {
      out.push({ kind: "missing", field: child(name) });
      continue;
    }
    if (required.has(name) && sdk.optional) {
      out.push({
        kind: "required",
        field: child(name),
        detail: "required in the reference, optional in the SDK",
      });
    }
    compare(ctx, prop, sdk.types, child(name), out, field === "query");
  }
  for (const name of sdkProps.keys()) {
    if (!specProps.has(name)) out.push({ kind: "extra", field: child(name) });
  }
}

// --- operations and call sites -----------------------------------------------

/** A media type without its parameters: `application/x+json;version=1` → `application/x+json`. */
const essence = (media) => media.split(";")[0].trim().toLowerCase();

/**
 * The entry of a `content` map for one media type: the exact key, else the
 * one with the same essence. A reference that declares a vendor type with a
 * version (`application/vnd.letta.trajectory+json;version=1`) matches a call
 * that asks for exactly that, and `application/json` matches only itself.
 */
function mediaEntry(content, media) {
  if (content[media]) return content[media];
  const key = Object.keys(content).find((k) => essence(k) === essence(media));
  return key ? content[key] : undefined;
}

/**
 * The reference's request body, query parameters and success response. Body
 * and response keep every media type the reference declares, so a call site
 * is compared with the one it actually sends or asks for.
 */
export function specShapes(spec, path, method) {
  const op = spec.paths?.[path]?.[method.toLowerCase()];
  const content = op?.requestBody?.content ?? {};
  const query = (op?.parameters ?? [])
    .map((p) => deref(spec, p).schema)
    .filter((p) => p.in === "query");
  const success = Object.entries(op?.responses ?? {}).find(([code]) =>
    /^2/.test(code),
  )?.[1];
  return {
    body: Object.keys(content).length
      ? {
          media: Object.keys(content),
          schema: content["application/json"]?.schema,
          required: op.requestBody.required,
        }
      : undefined,
    query: {
      type: "object",
      properties: Object.fromEntries(
        query.map((p) => [p.name, p.schema ?? {}]),
      ),
      required: query.filter((p) => p.required).map((p) => p.name),
    },
    response: deref(spec, success ?? {}).schema.content ?? {},
  };
}

const propertyType = (checker, type, name, at) => {
  const sym = checker.getPropertyOfType(type, name);
  return sym ? checker.getTypeOfSymbolAtLocation(sym, at) : undefined;
};

/**
 * The keys `serializeReadParams` (introspection-http `resources/reads.ts`)
 * consumes on the client, each with the wire parameter it becomes, if any.
 * `listRead` and `arrowRead` send their params through it, so these keys are
 * never on the wire themselves.
 */
const READ_PARAMS = new Map([
  ["order", "direction"],
  ["start", "start_date"],
  ["end", "end_date"],
  ["lookback", "start_date"],
  ["format", undefined],
  ["signal", undefined],
]);

/** Bodies `fetch` encodes itself, by the media type it sends them as. */
const ENCODED_BODIES = new Map([
  ["FormData", "multipart/form-data"],
  ["URLSearchParams", "application/x-www-form-urlencoded"],
]);

/** The string an expression evaluates to, through consts and templates. */
function literalString(checker, node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    for (const span of node.templateSpans) {
      const part = literalString(checker, span.expression);
      if (part === undefined) return undefined;
      text += part + span.literal.text;
    }
    return text;
  }
  const type = checker.getTypeAtLocation(node);
  return type.isStringLiteral() ? type.value : undefined;
}

/** A property of an object literal, matched case-insensitively. */
const literalProperty = (obj, name) =>
  obj.properties.find(
    (p) =>
      ts.isPropertyAssignment(p) &&
      p.name
        .getText()
        .replace(/^["']|["']$/g, "")
        .toLowerCase() === name,
  );

/**
 * The media type a call asks for in its `Accept` header: undefined without
 * one (the client then reads JSON), or null when it is not a literal.
 */
function acceptOf(checker, opts) {
  if (!opts || !ts.isObjectLiteralExpression(opts)) return undefined;
  const headers = literalProperty(opts, "headers")?.initializer;
  if (!headers) return undefined;
  if (!ts.isObjectLiteralExpression(headers)) {
    const type = checker.getTypeAtLocation(headers);
    const accept =
      propertyType(checker, type, "Accept", headers) ??
      propertyType(checker, type, "accept", headers);
    if (!accept) return undefined;
    return accept.isStringLiteral() ? accept.value : null;
  }
  const accept = literalProperty(headers, "accept")?.initializer;
  return accept ? (literalString(checker, accept) ?? null) : undefined;
}

/** The second type argument of `Paginator<T, TPage>`: the wire page. */
function pageType(checker, call) {
  const returned = checker.getResolvedSignature(call)?.getReturnType();
  if (!returned || !(returned.objectFlags & ts.ObjectFlags.Reference))
    return undefined;
  return checker.getTypeArguments(returned)[1];
}

/**
 * The SDK's body, query and response types at a call site. A slot is a
 * `ts.Type`, `undefined` (nothing sent), `{ notJson }` for a response the
 * call site reads as something other than JSON, or `{ unresolved }` for one
 * whose type says nothing about the wire. `accept` is the media type the
 * call asks for (see acceptOf).
 */
export function callSiteTypes(checker, site) {
  const types = slotTypes(checker, site);
  const opts =
    site.kind === "fetch" ? site.call.arguments[1] : site.call.arguments[0];
  return {
    ...types,
    accept: site.kind === "helper" ? undefined : acceptOf(checker, opts),
  };
}

function slotTypes(checker, site) {
  const { kind, call } = site;
  if (kind === "request" || kind === "stream") {
    const opts = call.arguments[0];
    const type = checker.getTypeAtLocation(opts);
    const expect = propertyType(checker, type, "expect", opts);
    const reads =
      kind === "stream"
        ? "event stream"
        : expect?.isStringLiteral() && expect.value !== "json"
          ? `${expect.value} body`
          : undefined;
    let response;
    if (reads) response = { notJson: reads };
    else {
      const returned = checker.getResolvedSignature(call)?.getReturnType();
      response = returned && checker.getAwaitedType(returned);
    }
    return {
      body: propertyType(checker, type, "body", opts),
      query: propertyType(checker, type, "query", opts),
      response,
    };
  }
  if (kind === "helper") {
    const query =
      call.arguments[2] && checker.getTypeAtLocation(call.arguments[2]);
    // Every pagination helper adds the page's `next` cursor itself; the read
    // helpers also turn READ_PARAMS keys into their wire parameters.
    const reads = site.helper !== "paginateGet";
    const has = (key) => query && checker.getPropertyOfType(query, key);
    return {
      body: undefined,
      query,
      clientQuery: reads ? [...READ_PARAMS.keys()] : [],
      implicitQuery: [
        "next",
        ...(reads
          ? [...READ_PARAMS]
              .filter(([k, wire]) => wire && has(k))
              .map(([, wire]) => wire)
          : []),
      ],
      response:
        site.helper === "arrowRead"
          ? { notJson: "Arrow IPC stream" }
          : pageType(checker, call),
    };
  }
  // A direct `fetch(url, init)`: the body is whatever `init.body` holds. The
  // call resolves to a `Response`, whose own members (`ok`, `headers`, ...)
  // are not the wire fields; those are read after the call.
  const init = call.arguments[1];
  const initType = init && checker.getTypeAtLocation(init);
  return {
    body: initType && propertyType(checker, initType, "body", init),
    query: undefined,
    response: { unresolved: "a fetch Response, read after the call" },
  };
}

/** The media type of a body `fetch` encodes itself, or undefined for JSON. */
const encodedMedia = (type) =>
  members(type)
    .map((t) => ENCODED_BODIES.get(t.symbol?.name))
    .find(Boolean);

function compareBody(ctx, shapes, body, out) {
  const { checker } = ctx;
  const media = body && (encodedMedia(body) ?? "application/json");
  const why = media === "application/json" && unresolvable(checker, body);
  if (why) {
    out.push({ kind: "unresolvable", field: "body", detail: why });
  } else if (!shapes.body) {
    if (body)
      out.push({
        kind: "extra",
        field: "body",
        detail: `the reference takes no body, SDK sends ${media}`,
      });
  } else if (!body) {
    if (shapes.body.required)
      out.push({ kind: "missing", field: "body", detail: "required body" });
  } else if (!shapes.body.media.some((m) => essence(m) === essence(media))) {
    out.push({
      kind: "type",
      field: "body",
      detail: `reference takes ${shapes.body.media.join(", ")}, SDK sends ${media}`,
    });
  } else if (media === "application/json") {
    ctx.run(shapes.body.schema, body, "body");
  }
  // A form body `fetch` encodes itself matches the reference's media type,
  // but carries no field types to compare, like a non-JSON response.
}

function compareQuery(ctx, shapes, types, out) {
  const { checker } = ctx;
  const query = ctx.sent(types.query);
  const why = query && unresolvable(checker, query);
  const findings = [];
  if (why) findings.push({ kind: "unresolvable", field: "query", detail: why });
  else if (query) compare(ctx.fresh(), shapes.query, query, "query", findings);
  else {
    for (const name of shapes.query.required)
      findings.push({ kind: "missing", field: `query.${name}` });
  }
  const implicit = new Set(
    (types.implicitQuery ?? []).map((n) => `query.${n}`),
  );
  const client = new Set((types.clientQuery ?? []).map((n) => `query.${n}`));
  out.push(
    ...findings.filter(
      (f) =>
        !(f.kind === "missing" && implicit.has(f.field)) &&
        !(f.kind === "extra" && client.has(f.field)),
    ),
  );
}

/**
 * The response, compared with the reference's schema for the media type the
 * call asks for. A call site that reads no JSON (an event stream, raw bytes,
 * an Arrow page, `expect: "empty"`) or discards the body (`void`) declares
 * no fields to compare.
 */
function compareResponse(ctx, shapes, types, out) {
  const { checker } = ctx;
  const response = types.response;
  if (!response || response.notJson) return;
  if (response.unresolved) {
    out.push({
      kind: "unresolvable",
      field: "response",
      detail: response.unresolved,
    });
    return;
  }
  if (!members(response).length) return;
  const reason =
    unresolvable(checker, response) ??
    (types.accept === null ? "Accept header is not a literal" : undefined);
  if (reason) {
    out.push({ kind: "unresolvable", field: "response", detail: reason });
    return;
  }
  const media = types.accept ?? "application/json";
  const entry = mediaEntry(shapes.response, media);
  if (entry?.schema) {
    ctx.run(entry.schema, response, "response");
    return;
  }
  const declared = Object.keys(shapes.response);
  out.push({
    kind: "extra",
    field: "response",
    detail: entry
      ? `the reference declares ${media} without a schema`
      : `the reference declares no ${media} response${declared.length ? ` (only ${declared.join(", ")})` : ""}`,
  });
}

/**
 * Field findings for one call site of one operation:
 * `{ kind, field, detail? }` with kind missing | extra | required | type |
 * unresolvable, and `field` rooted at `body`, `query` or `response`.
 */
export function compareCallSite(spec, checker, shapes, types) {
  const out = [];
  const fresh = () => ({ spec, checker, seen: new Set() });
  const ctx = {
    ...fresh(),
    fresh,
    run: (schema, type, field) => compare(fresh(), schema, type, field, out),
    sent: (type) =>
      type && members(type).length && !isEmptyObject(checker, type)
        ? type
        : undefined,
  };
  compareBody(ctx, shapes, ctx.sent(types.body), out);
  compareQuery(ctx, shapes, types, out);
  compareResponse(ctx, shapes, types, out);
  return out;
}
