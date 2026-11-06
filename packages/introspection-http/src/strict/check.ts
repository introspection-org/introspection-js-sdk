/**
 * Strict decoding: report the response fields this SDK does not model.
 *
 * Loaded only when strict decoding is on (`INTROSPECTION_STRICT_SCHEMA=1` or
 * the client's `strictSchema` option), through a dynamic import, so neither
 * this module nor the schemas it reads ship in a client's main bundle.
 */

import { SchemaDriftError } from "@introspection-sdk/types";
import schemas from "./schemas.json" with { type: "json" };

/** The subset of JSON Schema `scripts/gen-strict-schemas.mjs` writes. */
interface Schema {
  $ref?: string;
  const?: unknown;
  type?: "object" | "array";
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  items?: Schema;
  anyOf?: Schema[];
}

interface Schemas {
  $defs: Record<string, Schema>;
  keys: Record<string, Schema>;
}

const SCHEMAS = schemas as Schemas;
const REF = "#/$defs/";

function resolve(schema: Schema): Schema {
  let current = schema;
  while (current.$ref) {
    const target = SCHEMAS.$defs[current.$ref.slice(REF.length)];
    if (!target)
      throw new Error(`strict schema: no definition ${current.$ref}`);
    current = target;
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an object branch's `const` discriminators agree with `value`. */
function matches(schema: Schema, value: Record<string, unknown>): boolean {
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    const target = resolve(prop);
    if ("const" in target && key in value && value[key] !== target.const) {
      return false;
    }
  }
  return true;
}

function unmodelledUnion(
  branches: Schema[],
  value: unknown,
  at: string,
): string[] {
  const kind = Array.isArray(value) ? "array" : "object";
  const fitting = branches
    .map(resolve)
    .filter((b) => b.type === kind)
    .filter(
      (b) => kind === "array" || matches(b, value as Record<string, unknown>),
    );
  let best: string[] | null = null;
  for (const branch of fitting) {
    const found = unmodelled(branch, value, at);
    if (best === null || found.length < best.length) best = found;
    if (found.length === 0) break;
  }
  return best ?? [];
}

/**
 * The JSON paths of the keys in `value` that `schema` does not model, such as
 * `$.records[0].color`. A key is reported when its object's schema is closed
 * (`additionalProperties: false`); an open map's values are still checked.
 */
function unmodelled(input: Schema, value: unknown, at = "$"): string[] {
  const schema = resolve(input);
  if (schema.anyOf) return unmodelledUnion(schema.anyOf, value, at);
  if (schema.type === "array" && Array.isArray(value)) {
    const items = schema.items;
    if (!items) return [];
    return value.flatMap((item, index) =>
      unmodelled(items, item, `${at}[${index}]`),
    );
  }
  if (schema.type !== "object" || !isRecord(value)) return [];
  const found: string[] = [];
  for (const [key, raw] of Object.entries(value)) {
    const prop = schema.properties?.[key];
    const extra = schema.additionalProperties;
    if (prop) found.push(...unmodelled(prop, raw, `${at}.${key}`));
    else if (extra === false) found.push(`${at}.${key}`);
    else if (typeof extra === "object") {
      found.push(...unmodelled(extra, raw, `${at}.${key}`));
    }
  }
  return found;
}

/**
 * Throw a {@link SchemaDriftError} when `payload`, the JSON a request to
 * `path` returned, holds a field the response type `key` does not model.
 */
export function checkResponse(
  key: string,
  payload: unknown,
  path: string,
): void {
  const schema = SCHEMAS.keys[key];
  if (!schema) {
    throw new Error(
      `strict schema: no schema for "${key}"; run \`pnpm gen:strict-schemas\``,
    );
  }
  const fields = unmodelled(schema, payload);
  if (fields.length > 0) throw new SchemaDriftError({ path, fields });
}
