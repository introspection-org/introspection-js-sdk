/**
 * The name of a response type, as a request passes it for strict decoding:
 * `request<Runtime>({ ..., schema: "Runtime" })`.
 *
 * At runtime it is the plain string. At compile time it carries `T`, which is
 * how `scripts/gen-strict-schemas.mjs` finds the type each name stands for and
 * writes its schema into `strict/schemas.json`; that script also checks the
 * string spells `T`. A generic helper takes its caller's key as a
 * `SchemaKey<T>` parameter and passes it through.
 */
export type SchemaKey<T> = string & {
  // `length` keeps the brand from being a weak type a literal can't satisfy.
  readonly length: number;
  readonly __schemaOf?: (type: T) => void;
};

/** The environment variable that turns strict decoding on (`1` / `true`). */
export const STRICT_SCHEMA_ENV = "INTROSPECTION_STRICT_SCHEMA";

/**
 * Whether `INTROSPECTION_STRICT_SCHEMA` is set, where an environment exists.
 * Read through `globalThis` so the module stays browser-safe.
 */
export function strictSchemaFromEnv(): boolean {
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  const value = env?.[STRICT_SCHEMA_ENV]?.trim().toLowerCase() ?? "";
  return ["1", "true", "yes", "on"].includes(value);
}
