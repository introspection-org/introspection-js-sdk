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
 * mapped to `Record<string, unknown>`, a multipart upload, a body serialized
 * before the call), the call site is reported as unresolvable rather than
 * skipped. A check that passes because it compared nothing teaches the reader
 * that green means checked.
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

/** The branches of a schema with `null` dropped, each dereferenced. */
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
      .map((type) => ({ schema: { ...s, type }, ref }));
  }
  if (s.type === "null") return [];
  return [{ schema: s, ref }];
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
  if (parts.some((t) => t.symbol?.name === "FormData"))
    return "multipart (FormData)";
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
  if (specKinds.has("any") || sdkKinds.has("any")) return;
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
  if (!specObjects.length || !tsObjects.length) return;

  const key = `${specObjects.map((b) => b.ref).join("|")}::${tsObjects.map((t) => checker.typeToString(t)).join("|")}`;
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

/** The reference's request body, query parameters and JSON response. */
export function specShapes(spec, path, method) {
  const op = spec.paths?.[path]?.[method.toLowerCase()];
  const content = op?.requestBody?.content ?? {};
  const json = content["application/json"];
  const query = (op?.parameters ?? [])
    .map((p) => deref(spec, p).schema)
    .filter((p) => p.in === "query");
  const success = Object.entries(op?.responses ?? {}).find(([code]) =>
    /^2/.test(code),
  )?.[1];
  return {
    body: json
      ? { schema: json.schema, required: op.requestBody.required }
      : Object.keys(content).length
        ? { media: Object.keys(content) }
        : undefined,
    query: {
      type: "object",
      properties: Object.fromEntries(
        query.map((p) => [p.name, p.schema ?? {}]),
      ),
      required: query.filter((p) => p.required).map((p) => p.name),
    },
    response: deref(spec, success ?? {}).schema.content?.["application/json"]
      ?.schema,
  };
}

const propertyType = (checker, type, name, at) => {
  const sym = checker.getPropertyOfType(type, name);
  return sym ? checker.getTypeOfSymbolAtLocation(sym, at) : undefined;
};

/** The second type argument of `Paginator<T, TPage>`: the wire page. */
function pageType(checker, call) {
  const returned = checker.getResolvedSignature(call)?.getReturnType();
  if (!returned || !(returned.objectFlags & ts.ObjectFlags.Reference))
    return undefined;
  return checker.getTypeArguments(returned)[1];
}

/**
 * The SDK's body, query and response types at a call site. A slot is a
 * `ts.Type`, `undefined` (nothing sent), or `{ notJson }` for a response the
 * call site reads as something other than JSON.
 */
export function callSiteTypes(checker, site) {
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
    // Every pagination helper adds the page's `next` cursor itself.
    return {
      body: undefined,
      query,
      implicitQuery: ["next"],
      response:
        site.helper === "arrowRead"
          ? { notJson: "Arrow IPC stream" }
          : pageType(checker, call),
    };
  }
  // A direct `fetch(url, init)`: the body is whatever `init.body` holds and
  // the response is a `Response` read after the call.
  const init = call.arguments[1];
  const initType = init && checker.getTypeAtLocation(init);
  return {
    body: initType && propertyType(checker, initType, "body", init),
    query: undefined,
    response: checker.getAwaitedType(
      checker.getResolvedSignature(call).getReturnType(),
    ),
  };
}

/**
 * Field findings for one call site of one operation:
 * `{ kind, field, detail? }` with kind missing | extra | required | type |
 * unresolvable, and `field` rooted at `body`, `query` or `response`.
 */
export function compareCallSite(spec, checker, shapes, types) {
  const out = [];
  const run = (schema, type, field) =>
    compare({ spec, checker, seen: new Set() }, schema, type, field, out);
  const sent = (type) =>
    type && members(type).length && !isEmptyObject(checker, type)
      ? type
      : undefined;

  // Request body.
  const body = sent(types.body);
  const bodyWhy = body && unresolvable(checker, body);
  if (bodyWhy) {
    out.push({ kind: "unresolvable", field: "body", detail: bodyWhy });
  } else if (shapes.body?.media && body) {
    out.push({
      kind: "type",
      field: "body",
      detail: `reference takes ${shapes.body.media.join(", ")}, SDK sends JSON`,
    });
  } else if (shapes.body?.schema) {
    if (body) run(shapes.body.schema, body, "body");
    else if (shapes.body.required)
      out.push({ kind: "missing", field: "body", detail: "required body" });
  } else if (body) {
    out.push({
      kind: "extra",
      field: "body",
      detail: "the reference takes no body",
    });
  }

  // Query parameters.
  const query = sent(types.query);
  const queryWhy = query && unresolvable(checker, query);
  const implicit = new Set(
    (types.implicitQuery ?? []).map((n) => `query.${n}`),
  );
  if (queryWhy)
    out.push({ kind: "unresolvable", field: "query", detail: queryWhy });
  else if (query) run(shapes.query, query, "query");
  else {
    for (const name of shapes.query.required)
      out.push({ kind: "missing", field: `query.${name}` });
  }
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].kind === "missing" && implicit.has(out[i].field))
      out.splice(i, 1);
  }

  // Response. A call site that reads no JSON (an event stream, raw bytes, an
  // Arrow page, `expect: "empty"`) or discards the body (`void`) declares no
  // fields to compare.
  const response = types.response;
  if (response && !response.notJson && members(response).length) {
    const reason = unresolvable(checker, response);
    if (reason)
      out.push({ kind: "unresolvable", field: "response", detail: reason });
    else if (shapes.response) run(shapes.response, response, "response");
    else
      out.push({
        kind: "extra",
        field: "response",
        detail: "the reference declares no JSON response",
      });
  }
  return out;
}
