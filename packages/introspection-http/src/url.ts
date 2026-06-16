/**
 * URL helpers shared by every Introspection HTTP transport.
 *
 * Auth-agnostic: how a request is authenticated (bearer token vs session
 * cookie) is the caller's concern — these only assemble the URL.
 */

/** Drop any trailing slashes so a base URL joins cleanly with a path. */
export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Join a base URL and a path with exactly one separating slash. */
export function joinUrl(base: string, path: string): string {
  const b = stripTrailingSlash(base);
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

/**
 * Serialize a query object into a `?a=1&b=2` string. Skips `null` /
 * `undefined` values and expands arrays into repeated keys. Returns the
 * empty string when there is nothing to encode.
 */
export function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) sp.append(k, String(item));
    } else {
      sp.set(k, String(v));
    }
  }
  const q = sp.toString();
  return q ? `?${q}` : "";
}
