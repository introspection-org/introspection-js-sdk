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

/**
 * Default `caller.target` from the environment, leaving an explicit value
 * alone.
 *
 * The header above already routes tasks. This adds the signed, persisted half:
 * the target is minted onto the runner's session, so it survives a token
 * refresh and is what the Data Plane falls back to when the MCP proxy hop
 * arrives without its header. Explicit code always wins — a caller that set
 * `caller.target` itself has said something more specific than an env var.
 */
export function withDevTarget<T extends { caller?: Record<string, unknown> }>(
  opts?: T,
): T | undefined {
  const target = resolveDevTarget();
  if (!target) return opts;
  const caller = opts?.caller;
  if (caller?.target !== undefined) return opts;
  return {
    ...((opts ?? {}) as T),
    caller: { ...(caller ?? {}), target },
  };
}
