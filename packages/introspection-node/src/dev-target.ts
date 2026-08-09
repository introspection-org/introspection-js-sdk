/**
 * Development-target resolution — which `introspection dev` server this
 * process's tasks should reach.
 *
 * Two developers can run `introspection dev` against one shared Runtime. A
 * task created by a shared application credential carries no developer, so the
 * platform cannot tell their machines apart; the caller names one instead.
 * `introspection dev` prints the value to set:
 *
 * ```
 * serving as: roland
 * for your app: INTROSPECTION_DEV_TARGET=roland
 * ```
 *
 * Carried as a header rather than on the runner's `caller` payload: `caller`
 * is descriptive metadata the platform never acts on, and a target is a
 * per-request selector the platform does act on. Keeping them apart is what
 * lets `caller` stay a free-form bag, and it is the only transport that
 * reaches a bare `POST /v1/tasks` with a dev API key, whose JWT is minted from
 * the key row with no per-request input path.
 *
 * Deliberately env-only, with no `os.userInfo()` fallback. Defaulting to the
 * local username would be zero-config on a laptop and wrong everywhere else: a
 * process running in a shared development deployment under an account like
 * `node` would silently name a machine nobody is serving and fail closed,
 * where today it reaches the one connected dev server. The CLI defaults to the
 * username because it is naming *itself* and always runs on the developer's
 * machine; this names *someone else's* machine and can run anywhere.
 *
 * Inert outside development: the Data Plane consults a target only on the
 * development pin path, so a stray value in staging or production is ignored.
 */

/** Header carrying the target on requests that have no runner to ride. */
export const DEV_TARGET_HEADER = "x-introspection-dev-target";

/** The env var `introspection dev` prints and both the CLI and SDK read. */
export const DEV_TARGET_ENV = "INTROSPECTION_DEV_TARGET";

/**
 * Percent-encode to RFC 3986, so the header carries identical bytes on the
 * wire for the same target.
 *
 * `encodeURIComponent` leaves `!'()*` alone where Python's `quote(safe="")`
 * and the Rust client encode them. The Data Plane decodes before it
 * normalizes, so either form routes — but a header that differs by which
 * client sent it is a debugging trap for no benefit.
 */
function encodeTarget(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * The development target for this process, or `undefined` when unset.
 *
 * Percent-encoded, because the value becomes an HTTP header and a header is
 * bytes: a login name like `andré` is not transmissible as-is, and a runtime
 * that lets it through sends latin-1 bytes the server would read back as a
 * different string. Encoding here is lossless and costs nothing for the
 * ordinary ASCII name, which encodes to itself.
 *
 * Safe to send encoded because the Data Plane decodes before it normalizes,
 * so `andré` and `andr%C3%A9` land on the same target as the `--as andré`
 * the CLI advertises over protobuf, where no encoding is needed.
 *
 * Read through `globalThis.process` so the module stays importable from
 * non-Node runtimes that share this package's build.
 */
export function resolveDevTarget(): string | undefined {
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  const raw = env?.[DEV_TARGET_ENV];
  const trimmed = raw?.trim();
  return trimmed ? encodeTarget(trimmed) : undefined;
}
