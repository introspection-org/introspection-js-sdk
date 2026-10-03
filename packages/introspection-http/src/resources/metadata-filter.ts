/**
 * Flatten the `metadata` dict into the repeated `?metadata=key:value`
 * params the API takes.
 *
 * The wire format is a repeated string param because a query string has no
 * native encoding for a map; the dict lives here so callers do not have to
 * hand-encode the transport representation or manage repeated query params.
 */
export function encodeMetadataFilter<
  P extends { metadata?: Record<string, string> },
>(params?: P): (Omit<P, "metadata"> & { metadata?: string[] }) | undefined {
  if (!params) return undefined;
  const { metadata, ...rest } = params;
  const entries = Object.entries(metadata ?? {});
  if (entries.length === 0) return rest;
  return {
    ...rest,
    metadata: entries.map(([key, value]) => `${key}:${value}`),
  };
}
