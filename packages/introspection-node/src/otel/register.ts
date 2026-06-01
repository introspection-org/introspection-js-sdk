/**
 * Zero-code preload entry point for Introspection tracing.
 *
 * Usage (ESM):
 *
 * ```bash
 * node --import @introspection-sdk/introspection-node/otel/register app.js
 * ```
 *
 * Runs `introspection.init()` from the environment **before** the app's module
 * graph executes, so no `init()` call is needed in application source. Because
 * the Anthropic / Gemini one-liner works by prototype-patching the SDK classes
 * (see `AnthropicInstrumentor.instrumentClass`), every client constructed after
 * this preload is traced with zero code changes.
 *
 * Configuration is read from the usual environment variables
 * (`INTROSPECTION_TOKEN`, `INTROSPECTION_SERVICE_NAME`,
 * `INTROSPECTION_BASE_OTEL_URL`). If no token is configured the preload logs a
 * warning and does nothing, so it never crashes the host application.
 *
 * This is the counterpart to the private SDK's `register.ts`, adapted to the
 * `src/otel` surface: it drives the existing `init()` rather than registering an
 * import-in-the-middle loader hook (the prototype-patch path does not need one).
 */
import { logger } from "../utils.js";
import { init } from "./init.js";

/**
 * Run `init()` if a token is configured. Exported (and awaited at module load)
 * so tests can invoke it deterministically; the module-level `await` below
 * guarantees the preload finishes — including framework auto-discovery and the
 * prototype patch — before Node evaluates the application entry point.
 */
export async function registerFromEnv(): Promise<void> {
  if (!process.env.INTROSPECTION_TOKEN) {
    logger.warn(
      "[introspection] register: INTROSPECTION_TOKEN not set; tracing not initialised.",
    );
    return;
  }
  try {
    await init();
    logger.debug("[introspection] register: tracing initialised from preload.");
  } catch (err) {
    // Never let a preload failure take down the host application.
    logger.warn(`[introspection] register: init failed: ${String(err)}`);
  }
}

await registerFromEnv();
