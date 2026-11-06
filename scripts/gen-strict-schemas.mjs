#!/usr/bin/env node
/**
 * Generate the response schemas strict decoding checks against
 * (`packages/introspection-http/src/strict/schemas.json`).
 *
 * The response types are hand-written TypeScript, so nothing at runtime knows
 * which fields a response type names. Every JSON request names its response
 * type with a `SchemaKey<T>` literal (`schema: "Runtime"`). This script reads
 * the SDK's sources with the TypeScript compiler, finds every such literal,
 * checks that it spells the type it stands for, and writes a JSON Schema for
 * that type: `additionalProperties: false` on every object the SDK models,
 * except where the type is open by design (an index signature with no named
 * properties, such as `Record<string, unknown>`, or an interface tagged
 * `@openSchema`).
 *
 *   node scripts/gen-strict-schemas.mjs          # write schemas.json
 *   node scripts/gen-strict-schemas.mjs --check  # fail if it is stale
 *   node scripts/gen-strict-schemas.mjs --fix    # also add missing `schema` keys
 *
 * Run `pnpm build` first: the packages import each other through `dist`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = [
  "introspection-http",
  "introspection-node",
  "introspection-browser",
];
const OUT = path.join(
  ROOT,
  "packages/introspection-http/src/strict/schemas.json",
);
const BRAND = "__schemaOf";
const OPEN_TAG = "openSchema";

const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
const FIX = args.has("--fix");

function sourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name))
      out.push(full);
  }
  return out;
}

const roots = PACKAGES.flatMap((p) =>
  sourceFiles(path.join(ROOT, "packages", p, "src")),
);
const program = ts.createProgram(roots, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  resolveJsonModule: true,
});
const checker = program.getTypeChecker();
const rel = (file) => path.relative(ROOT, file);
const where = (node) => {
  const sf = node.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
  return `${rel(sf.fileName)}:${line + 1}`;
};

const problems = [];
const edits = new Map(); // file -> [{ start, end, text }]
function edit(node, text, start = node.getStart(), end = node.getEnd()) {
  const file = node.getSourceFile().fileName;
  if (!edits.has(file)) edits.set(file, []);
  edits.get(file).push({ start, end, text });
}

/** Whether `type` mentions a type parameter (a generic helper's own `T`). */
function isGeneric(type, seen = new Set()) {
  if (seen.has(type)) return false;
  seen.add(type);
  if (type.flags & ts.TypeFlags.TypeParameter) return true;
  if (type.isUnionOrIntersection())
    return type.types.some((t) => isGeneric(t, seen));
  const args =
    type.aliasTypeArguments ??
    (type.flags & ts.TypeFlags.Object ? checker.getTypeArguments(type) : []);
  return (args ?? []).some((t) => isGeneric(t, seen));
}

const typeText = (type) =>
  checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);

// --- SchemaKey<T>: the type a literal stands for --------------------------

/** `T` when `type` (or a member of it) is `SchemaKey<T>` with a concrete `T`. */
function schemaTarget(type) {
  const found = schemaParam(type);
  return found && !isGeneric(found) ? found : null;
}

/** `T` when `type` (or a member of it) is `SchemaKey<T>`, generic or not. */
function schemaParam(type) {
  if (!type) return null;
  for (const member of type.isUnion() ? type.types : [type]) {
    const brand = checker.getPropertyOfType(member, BRAND);
    if (!brand) continue;
    const brandType = checker.getNonNullableType(
      checker.getTypeOfSymbol(brand),
    );
    const [signature] = brandType.getCallSignatures();
    const [param] = signature?.getParameters() ?? [];
    if (!param) continue;
    return checker.getTypeOfSymbol(param);
  }
  return null;
}

// --- type -> JSON Schema ----------------------------------------------------

const defs = new Map(); // name -> schema
const defByType = new Map(); // type id -> name
const pending = new Set();

const OPEN = {};
const isOurs = (decl) => {
  const file = decl.getSourceFile().fileName;
  return file.startsWith(path.join(ROOT, "packages") + path.sep);
};

function declarations(type) {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  return symbol?.getDeclarations() ?? [];
}

function isOpenTagged(type) {
  const parts = type.isIntersection() ? type.types : [type];
  return parts.some((part) =>
    [part.aliasSymbol, part.getSymbol()].some((symbol) =>
      symbol?.getJsDocTags(checker).some((tag) => tag.name === OPEN_TAG),
    ),
  );
}

function named(type) {
  const symbol = type.aliasSymbol ?? type.getSymbol();
  if (!symbol) return null;
  const name = symbol.getName();
  if (name.startsWith("__")) return null; // an anonymous object literal type
  return typeText(type);
}

function convert(type) {
  if (
    type.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
  )
    return OPEN;
  if (type.flags & ts.TypeFlags.TypeParameter) return OPEN;
  if (type.isStringLiteral()) return { const: type.value };
  if (type.isUnion()) return convertUnion(type);
  if (checker.isArrayType(type)) {
    const [item] = checker.getTypeArguments(type);
    const items = item ? convert(item) : OPEN;
    return isEmpty(items) ? { type: "array" } : { type: "array", items };
  }
  if (checker.isTupleType(type)) return OPEN;
  if (!(type.flags & ts.TypeFlags.Object) && !type.isIntersection())
    return OPEN;
  if (type.getCallSignatures().length > 0) return OPEN;
  // An open map (`Record<string, T>`, `{ [key: string]: T }`): any key, but
  // a value the SDK models is still checked.
  const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  if (index && checker.getPropertiesOfType(type).length === 0) {
    const values = convert(checker.getNonNullableType(index));
    return isEmpty(values)
      ? OPEN
      : { type: "object", additionalProperties: values };
  }
  const decls = declarations(type);
  if (decls.length > 0 && !decls.some(isOurs)) return OPEN; // lib and third-party types
  if (decls.length === 0 && !type.isIntersection()) return OPEN;
  return convertNamed(type);
}

function isEmpty(schema) {
  return Object.keys(schema).length === 0;
}

function convertUnion(type) {
  const branches = [];
  for (const member of type.types) {
    if (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) continue;
    const schema = convert(member);
    if (schema.type === "object" || schema.type === "array" || schema.$ref) {
      branches.push(schema);
    }
  }
  const unique = [
    ...new Map(branches.map((b) => [JSON.stringify(b), b])).values(),
  ];
  if (unique.length === 0) return OPEN;
  if (unique.length === 1) return unique[0];
  return { anyOf: unique };
}

function convertNamed(type) {
  const name = named(type);
  if (!name) return convertObject(type);
  const id = type.id;
  const known = defByType.get(id);
  if (known) return { $ref: `#/$defs/${known}` };
  let defName = name;
  for (let n = 2; defs.has(defName) || pending.has(defName); n++)
    defName = `${name}~${n}`;
  defByType.set(id, defName);
  pending.add(defName);
  const schema = convertObject(type);
  pending.delete(defName);
  // The same type reached through `src` and through a package's `dist`.
  for (const [other, existing] of defs) {
    if (
      other.split("~")[0] === name &&
      JSON.stringify(existing) === JSON.stringify(schema)
    ) {
      defByType.set(id, other);
      replaceRefs(defName, other);
      return { $ref: `#/$defs/${other}` };
    }
  }
  defs.set(defName, schema);
  return { $ref: `#/$defs/${defName}` };
}

function replaceRefs(from, to) {
  const ref = `#/$defs/${from}`;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.$ref === ref) node.$ref = `#/$defs/${to}`;
    for (const value of Object.values(node)) visit(value);
  };
  for (const schema of defs.values()) visit(schema);
}

function convertObject(type) {
  const properties = {};
  for (const prop of checker.getPropertiesOfType(type)) {
    const decl = prop.valueDeclaration ?? prop.getDeclarations()?.[0];
    const propType = decl
      ? checker.getTypeOfSymbolAtLocation(prop, decl)
      : checker.getTypeOfSymbol(prop);
    if (prop.flags & ts.SymbolFlags.Method) continue;
    properties[prop.getName()] = convert(checker.getNonNullableType(propType));
  }
  const index = checker.getIndexTypeOfType(type, ts.IndexKind.String);
  const indexSchema = index ? convert(checker.getNonNullableType(index)) : null;
  let additionalProperties;
  if (Object.keys(properties).length === 0 && indexSchema) {
    additionalProperties = isEmpty(indexSchema) ? true : indexSchema; // an open map
  } else if (isOpenTagged(type)) {
    additionalProperties =
      indexSchema && !isEmpty(indexSchema) ? indexSchema : true;
  } else {
    additionalProperties = false;
  }
  const sorted = Object.fromEntries(
    Object.entries(properties).sort(([a], [b]) => a.localeCompare(b)),
  );
  return { type: "object", properties: sorted, additionalProperties };
}

// --- the walk over the sources ---------------------------------------------

const keys = new Map(); // key -> { schema, at }

function register(literal, target) {
  const expected = typeText(target);
  if (literal.text !== expected) {
    if (FIX) edit(literal, JSON.stringify(expected));
    else
      problems.push(
        `${where(literal)}: schema key "${literal.text}" should be "${expected}"`,
      );
  }
  const schema = convert(target);
  const prior = keys.get(expected);
  if (prior && JSON.stringify(prior.schema) !== JSON.stringify(schema)) {
    problems.push(
      `${where(literal)}: schema key "${expected}" names a different type than at ${prior.at}; give one of them a distinct name`,
    );
    return;
  }
  keys.set(expected, { schema, at: where(literal) });
}

function prop(objectLiteral, name) {
  return objectLiteral.properties.find(
    (p) =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      p.name.getText() === name,
  );
}

const NO_BODY = new Set(["empty", "bytes", "stream"]);

/** Every JSON `request<T>()` names its response type. */
function checkRequest(call) {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "request")
    return;
  const [opts] = call.arguments;
  if (!opts || !ts.isObjectLiteralExpression(opts) || !prop(opts, "path"))
    return;
  const expect = prop(opts, "expect");
  if (
    expect &&
    ts.isPropertyAssignment(expect) &&
    ts.isStringLiteral(expect.initializer) &&
    NO_BODY.has(expect.initializer.text)
  )
    return;
  const typeArg = call.typeArguments?.[0];
  const responseType = typeArg
    ? checker.getTypeFromTypeNode(typeArg)
    : checker.getTypeAtLocation(call);
  if (responseType.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) return;
  if (prop(opts, "schema")) return;
  if (isGeneric(responseType)) {
    problems.push(
      `${where(call)}: a generic request passes its caller's \`schema\` through`,
    );
  } else if (FIX) {
    const pathProp = prop(opts, "path");
    edit(
      pathProp,
      `, schema: ${JSON.stringify(typeText(responseType))}`,
      pathProp.getEnd(),
      pathProp.getEnd(),
    );
  } else {
    problems.push(
      `${where(call)}: request<${typeText(responseType)}> names no \`schema\` (run with --fix)`,
    );
  }
}

/**
 * A call to a generic helper (`paginateGet<T>`, `super(...)` of a collection
 * base) passes a key for every `SchemaKey<T>` parameter its `T` makes concrete.
 */
function checkHelperCall(call) {
  const signature = checker.getResolvedSignature(call);
  if (!signature) return;
  const params = signature.getParameters();
  const missing = [];
  params.forEach((param, index) => {
    const target = schemaParam(checker.getTypeOfSymbol(param));
    if (!target) return;
    const arg = call.arguments?.[index];
    if (
      arg &&
      arg.kind !== ts.SyntaxKind.UndefinedKeyword &&
      arg.getText() !== "undefined"
    )
      return;
    missing.push({ index, target });
  });
  if (missing.length === 0) return;
  const generic = missing.filter(({ target }) => isGeneric(target));
  for (const { target } of generic) {
    problems.push(
      `${where(call)}: passes no SchemaKey<${typeText(target)}>; pass the caller's key, or one for a concrete wider type (\`"Paginated<X>" as SchemaKey<Paginated<X>>\`)`,
    );
  }
  if (generic.length > 0) return;
  if (!FIX) {
    for (const { target } of missing) {
      problems.push(
        `${where(call)}: passes no SchemaKey<${typeText(target)}> (run with --fix)`,
      );
    }
    return;
  }
  const args = [...(call.arguments ?? [])].map((a) => a.getText());
  for (const { index, target } of missing) {
    while (args.length < index) args.push("undefined");
    args[index] = JSON.stringify(typeText(target));
  }
  const open = call.arguments.pos;
  const close = call.arguments.end;
  edit(call, args.join(", "), open, close);
}

function visit(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const target = schemaTarget(checker.getContextualType(node));
    if (target) register(node, target);
  }
  if (ts.isCallExpression(node)) {
    checkRequest(node);
    checkHelperCall(node);
  }
  if (ts.isNewExpression(node)) checkHelperCall(node);
  ts.forEachChild(node, visit);
}

for (const file of roots) visit(program.getSourceFile(file));

if (FIX && edits.size > 0) {
  for (const [file, list] of edits) {
    let text = fs.readFileSync(file, "utf8");
    for (const e of list.sort((a, b) => b.start - a.start)) {
      text = text.slice(0, e.start) + e.text + text.slice(e.end);
    }
    fs.writeFileSync(file, text);
    console.log(`fixed ${rel(file)}`);
  }
  console.log(
    "re-run without --fix once the edits are formatted (pnpm format)",
  );
  process.exit(0);
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}

const sortedEntries = (map) =>
  [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const output =
  JSON.stringify(
    {
      $comment: "Generated by scripts/gen-strict-schemas.mjs. Do not edit.",
      $defs: Object.fromEntries(sortedEntries(defs)),
      keys: Object.fromEntries(
        sortedEntries(keys).map(([k, v]) => [k, v.schema]),
      ),
    },
    null,
    1,
  ) + "\n";

if (CHECK) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== output) {
    console.error(
      `${rel(OUT)} is stale: run \`pnpm build && pnpm gen:strict-schemas\` and commit it`,
    );
    process.exit(1);
  }
  console.log(`${rel(OUT)} is current (${keys.size} keys, ${defs.size} types)`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, output);
  console.log(`wrote ${rel(OUT)} (${keys.size} keys, ${defs.size} types)`);
}
