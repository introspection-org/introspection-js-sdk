/**
 * Claude Agent SDK baggage propagation — real `claude` binary + recording proxy.
 *
 * The Claude Agent SDK shells out to the `claude` binary, which talks to
 * Anthropic's API over HTTPS from a subprocess. Polly's in-process adapters
 * can't intercept that traffic, so this test uses the recording proxy
 * (`tests/recording-proxy/`) to capture and replay the wire exchange. See
 * `tests/recording-proxy/README.md` for the rationale and license note.
 *
 * Covers the bug fix in packages/introspection-node/src/claude-hooks.ts:
 * both _onSessionStart (the hook the real SDK fires) and
 * _startSessionFromMessage call _resolveIdentity, so baggage set via
 * IntrospectionLogs.withAgent() / .withConversation() reaches the
 * claude.session span regardless of which path creates it.
 *
 * To record: POLLY_MODE=record ANTHROPIC_API_KEY=sk-ant-... pnpm test \
 *   -- test-claude-baggage-proxy
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  IntrospectionLogs,
  withIntrospection,
} from "@introspection-sdk/introspection-node/otel";
import { TestSpanExporter, IncrementalIdGenerator } from "../testing";
import { startProxy, type Proxy } from "../recording-proxy";

// Resolve relative to this test file so the path is correct no matter where
// pnpm test is invoked from. The recording proxy uses the same trick.
const RECORDINGS_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "recordings",
);

function recordingsExist(name: string): boolean {
  return existsSync(join(RECORDINGS_ROOT, name, "recording.har"));
}

// Each test spawns the `claude` binary and waits for a real Anthropic
// response — cold start + ~68KB system prompt + claude-sonnet latency can
// run to a minute. 3-minute timeout in record mode is generous but realistic.
const TEST_TIMEOUT_MS = 180_000;

describe("Claude Agent SDK baggage — real `claude` binary via recording proxy", () => {
  let exporter: TestSpanExporter | null = null;
  let proxy: Proxy | null = null;
  let savedBaseUrl: string | undefined;
  let savedApiKey: string | undefined;

  beforeEach(async () => {
    try {
      await import("@anthropic-ai/claude-agent-sdk");
    } catch {
      console.log("Skipping: @anthropic-ai/claude-agent-sdk not installed");
      return;
    }

    // In record mode the proxy forwards to api.anthropic.com using whatever
    // Anthropic credential is in the env (ANTHROPIC_API_KEY for a normal API
    // key, or CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR when running inside a
    // Claude Code session). In replay mode it serves the on-disk recordings.
    const mode = process.env.POLLY_MODE === "record" ? "record" : "replay";
    const hasAnyAnthropicAuth =
      !!process.env.ANTHROPIC_API_KEY ||
      !!process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
    if (mode === "record" && !hasAnyAnthropicAuth) {
      console.log(
        "Skipping: no Anthropic credential (set ANTHROPIC_API_KEY) for record mode",
      );
      return;
    }
    if (mode === "replay" && !recordingsExist("claude-baggage")) {
      console.log(
        "Skipping: no proxy recordings found at tests/recordings/claude-baggage/.\n" +
          "  Run: POLLY_MODE=record ANTHROPIC_API_KEY=sk-ant-... pnpm test -- test-claude-baggage-proxy",
      );
      return;
    }

    proxy = await startProxy({
      name: "claude-baggage",
      upstream: "https://api.anthropic.com",
      mode,
    });

    // Point the claude binary at the proxy. The probe earlier in this branch
    // confirmed claude-cli honors ANTHROPIC_BASE_URL.
    savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_BASE_URL = proxy.url;
    // In replay mode, ANTHROPIC_API_KEY is unused but the SDK refuses to
    // start without one — give it a placeholder.
    if (mode === "replay") {
      process.env.ANTHROPIC_API_KEY = "sk-ant-replay-placeholder";
    }

    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
    propagation.setGlobalPropagator(
      new CompositePropagator({
        propagators: [
          new W3CTraceContextPropagator(),
          new W3CBaggagePropagator(),
        ],
      }),
    );

    exporter = new TestSpanExporter();
  });

  afterEach(async () => {
    context.disable();
    trace.disable();
    propagation.disable();
    exporter = null;
    if (savedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedApiKey;
    if (proxy) {
      await proxy.stop();
      proxy = null;
    }
  });

  it(
    "withAgent + withConversation stamp baggage on the claude.session span",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      if (!exporter || !proxy) return;

      const sdk = await import("@anthropic-ai/claude-agent-sdk");

      // One shared instrumented SDK — the DX we're enabling.
      const tracedSdk = withIntrospection(sdk, {
        agentName: "default-agent",
        advanced: {
          spanExporter: exporter,
          idGenerator: new IncrementalIdGenerator(),
          useSimpleSpanProcessor: true,
        },
      });

      const introspect = new IntrospectionLogs({ token: "test-token" });
      const CONV_ID = "claude-baggage-conv-test";

      await introspect.withAgent("researcher", "researcher-1", () =>
        introspect.withConversation(CONV_ID, undefined, async () => {
          // The SDK throws if the stream ends without an explicit success
          // result (e.g. claude hits maxTurns). For this test we only care
          // about the spans the hooks emit, which are recorded by the time
          // the stream completes — so the error is swallowed.
          try {
            for await (const _msg of tracedSdk.query({
              prompt: "Say only the word ok.",
              options: { maxTurns: 3 },
            }) as AsyncIterable<unknown>) {
              // drain
            }
          } catch (e) {
            void e;
          }
        }),
      );

      await tracedSdk.forceFlush();
      const spans = exporter.getFinishedSpans();
      const session = spans.find((s) => s.name === "claude.session");
      expect(session).toBeDefined();
      // Baggage wins over the constructor default ("default-agent") and over
      // the session-id fallback for conversation id.
      expect(session?.attributes["gen_ai.agent.name"]).toBe("researcher");
      expect(session?.attributes["gen_ai.agent.id"]).toBe("researcher-1");
      expect(session?.attributes["gen_ai.conversation.id"]).toBe(CONV_ID);

      await tracedSdk.shutdown();
    },
  );

  it(
    "falls back to constructor options when no baggage is on the active context",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      if (!exporter || !proxy) return;

      const sdk = await import("@anthropic-ai/claude-agent-sdk");

      const tracedSdk = withIntrospection(sdk, {
        agentName: "default-agent",
        agentId: "default-agent-id",
        conversationId: "default-conv",
        advanced: {
          spanExporter: exporter,
          idGenerator: new IncrementalIdGenerator(),
          useSimpleSpanProcessor: true,
        },
      });

      try {
        for await (const _msg of tracedSdk.query({
          prompt: "Say only the word ok.",
          options: { maxTurns: 3 },
        }) as AsyncIterable<unknown>) {
          // drain
        }
      } catch (e) {
        void e;
      }

      await tracedSdk.forceFlush();
      const spans = exporter.getFinishedSpans();
      const session = spans.find((s) => s.name === "claude.session");
      expect(session).toBeDefined();
      expect(session?.attributes["gen_ai.agent.name"]).toBe("default-agent");
      expect(session?.attributes["gen_ai.agent.id"]).toBe("default-agent-id");
      expect(session?.attributes["gen_ai.conversation.id"]).toBe(
        "default-conv",
      );

      await tracedSdk.shutdown();
    },
  );
});
