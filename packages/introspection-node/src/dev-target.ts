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
 * The development target for this process, or `undefined` when unset.
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
  return trimmed ? trimmed : undefined;
}
