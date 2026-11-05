/**
 * The fields of `params` that are set, so a write never sends an absent one.
 * A field set to `[]`, `{}` or `null` is kept: only `undefined` is dropped.
 */
export function setFields<T extends object>(params: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}
