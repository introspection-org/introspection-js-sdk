/**
 * Integration discovery + setup loader for `introspection.init()`.
 *
 * Mirrors the Python SDK's registry: built-in integrations are resolved
 * lazily (a missing framework just skips its shim), `setupOnce` runs at most
 * once per identifier per process, and an integration may `deactivate` others.
 */

import { logger } from "../../utils.js";
import {
  DidNotEnable,
  type Integration,
  type IntegrationHandles,
  type IntegrationSetupContext,
} from "./base.js";

export { DidNotEnable };
export type { Integration, IntegrationHandles, IntegrationSetupContext };

/**
 * Built-in integrations, loaded lazily. Each thunk dynamically imports an
 * integration module; that module imports its framework at the top level, so
 * if the framework is not installed the import rejects and the integration is
 * skipped. Order matters only for `deactivates` resolution (handled below).
 */
const BUILTIN_INTEGRATIONS: ReadonlyArray<
  () => Promise<{ default: Integration }>
> = [
  () => import("./anthropic.js"),
  () => import("./gemini.js"),
  () => import("./openai-agents.js"),
  () => import("./vercel.js"),
  () => import("./claude-agent.js"),
  () => import("./langchain.js"),
  () => import("./mastra.js"),
  () => import("./pi.js"),
];

const installed = new Set<string>();
// Teardown callbacks returned by integration setupOnce (e.g. uninstrument a
// prototype patch), run by teardownIntegrations() on shutdown.
const teardowns: Array<() => void> = [];

/**
 * Distinguish "framework package not installed" (expected — skip quietly) from
 * a real error inside an installed integration (a bug we shouldn't hide).
 */
export function isModuleNotFound(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return true;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /Cannot find (module|package)|Failed to resolve/i.test(msg);
}

/**
 * Return the built-in integrations whose framework is importable.
 *
 * Each module's top-level framework import determines availability: a missing
 * package makes the dynamic import reject, which we log at debug and skip. Any
 * OTHER failure (a real error inside an installed integration) is surfaced at
 * warn level rather than silently swallowed — it's a bug, not an absent peer.
 */
export async function discoverIntegrations(): Promise<Integration[]> {
  const found: Integration[] = [];
  for (const load of BUILTIN_INTEGRATIONS) {
    try {
      const mod = await load();
      if (mod.default) found.push(mod.default);
    } catch (e) {
      if (isModuleNotFound(e)) {
        logger.debug(
          `Skipping integration (framework not installed): ${String(e)}`,
        );
      } else {
        logger.warn(
          `Integration failed to load with an unexpected error (skipping): ${String(e)}`,
        );
      }
    }
  }
  return found;
}

/**
 * Run each integration's `setupOnce` once, honouring `deactivates`.
 *
 * @returns the set of identifiers installed so far this process.
 */
export function setupIntegrations(
  integrations: Integration[],
  ctx: IntegrationSetupContext,
): Set<string> {
  // First-wins de-dupe by identifier.
  const byId = new Map<string, Integration>();
  for (const integration of integrations) {
    if (!byId.has(integration.identifier)) {
      byId.set(integration.identifier, integration);
    }
  }

  const disabled = new Set<string>();
  for (const integration of byId.values()) {
    for (const id of integration.deactivates ?? []) disabled.add(id);
  }

  for (const [identifier, integration] of byId) {
    if (disabled.has(identifier)) {
      logger.debug(
        `Skipping ${identifier} (deactivated by another integration)`,
      );
      continue;
    }
    if (installed.has(identifier)) continue;
    try {
      const teardown = integration.setupOnce(ctx);
      if (typeof teardown === "function") teardowns.push(teardown);
      installed.add(identifier);
    } catch (e) {
      if (e instanceof DidNotEnable) {
        logger.debug(`Could not enable ${identifier}: ${e.message}`);
        continue;
      }
      throw e;
    }
  }

  return new Set(installed);
}

/**
 * Run every integration teardown and clear the run-once guard, so the next
 * `setupIntegrations()` (e.g. after `introspection.shutdown()` + a fresh
 * `init()`) re-installs against the rebuilt provider instead of being skipped.
 */
export function teardownIntegrations(): void {
  for (const teardown of teardowns.splice(0)) {
    try {
      teardown();
    } catch (e) {
      logger.debug(`Error tearing down integration: ${String(e)}`);
    }
  }
  installed.clear();
}

/** Clear the run-once guard (running teardowns). Test-only utility. */
export function resetInstalledForTests(): void {
  teardownIntegrations();
}
