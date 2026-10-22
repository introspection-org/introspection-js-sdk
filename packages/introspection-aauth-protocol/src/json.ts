import { InvalidRequest } from "./errors.js";

/** A JSON object, as opposed to an array, a primitive or null. */
export const isJsonObject = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A request body that must be a JSON object; anything else is a 400. */
export function readJsonObject(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // answered below
  }
  if (!isJsonObject(parsed))
    throw new InvalidRequest("body must be a JSON object");
  return parsed;
}
