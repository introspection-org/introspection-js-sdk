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
  isModuleNotFound,
  type Integration,
  type IntegrationHandles,
  type IntegrationSetupContext,
} from "./base.js";

export { DidNotEnable, isModuleNotFound };
export type { Integration, IntegrationHandles, IntegrationSetupContext };

/**
 * Built-in integrations, loaded lazily. Each integration probes its optional
 * framework package at runtime, so importing the OTel barrel never requires
 * every optional framework SDK to be installed.
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

async function availableIntegrations(
  integrations: Integration[],
): Promise<Integration[]> {
  const available: Integration[] = [];

  for (const integration of integrations) {
    if (integration.isAvailable && !(await integration.isAvailable())) {
      continue;
    }
    available.push(integration);
  }

  return available;
}

/**
 * Return the built-in integrations whose framework is importable.
 *
 * Missing optional peer packages are expected and skipped quietly. Any OTHER
 * failure is surfaced at warn level rather than silently swallowed — it's a
 * bug, not an absent peer.
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
  return availableIntegrations(found);
}

/**
 * Run each integration's `setupOnce` once, honouring `deactivates`.
 *
 * @returns the set of identifiers installed so far this process.
 */
export async function setupIntegrations(
  integrations: Integration[],
  ctx: IntegrationSetupContext,
): Promise<Set<string>> {
  // First-wins de-dupe by identifier.
  const byId = new Map<string, Integration>();
  for (const integration of await availableIntegrations(integrations)) {
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
      const teardown = await integration.setupOnce(ctx);
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
