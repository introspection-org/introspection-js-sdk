/**
 * Capture path for the Introspection plugin's Claude Code / Codex observability.
 *
 * The consent tests carry the weight here. Everything else in this package is
 * recoverable if it misbehaves; capturing a session the user did not opt into is
 * not, so the gates are asserted from every direction — disabled, absent,
 * malformed, wrong host, and the env override in both directions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";

import { capture } from "../../packages/introspection-coding-agent/src/capture";
import {
  captureActivationPath,
  clearCaptureActivationRequest,
  materializeCaptureActivation,
  readCaptureActivation,
  requestCaptureActivation,
  requestCaptureActivationFromEnvironment,
} from "../../packages/introspection-coding-agent/src/activation";
import {
  coversHost,
  readTelemetryOverride,
  resolveTelemetryConfig,
} from "../../packages/introspection-coding-agent/src/config";
import { loadLoginProfile } from "../../packages/introspection-coding-agent/src/credentials";
import { readHostInfo } from "../../packages/introspection-coding-agent/src/host";
import {
  parseHookEvent,
  runHook,
} from "../../packages/introspection-coding-agent/src/hook";
import {
  captureStatePath,
  readCaptureState,
} from "../../packages/introspection-coding-agent/src/state";
import {
  responseIdForTurn,
  segmentTranscript,
} from "../../packages/introspection-coding-agent/src/turns";

/**
 * `InMemorySpanExporter.shutdown()` resets its own buffer, and `capture()` shuts
 * the provider down to force the flush — so the default exporter always reads
 * back empty. Retain a copy of everything handed to `export()` instead.
 */
class RetainingExporter extends InMemorySpanExporter {
  readonly kept: ReadableSpan[] = [];

  override export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.kept.push(...spans);
    super.export(spans, resultCallback);
  }
}

class FailingRetainingExporter extends RetainingExporter {
  override export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.kept.push(...spans);
    resultCallback({
      code: ExportResultCode.FAILED,
      error: new Error("collector unreachable"),
    });
  }
}

class DelayedRetainingExporter extends RetainingExporter {
  constructor(private readonly delayMs: number) {
    super();
  }

  override export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    setTimeout(() => super.export(spans, resultCallback), this.delayMs);
  }
}

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

/** A minimal but realistic Claude Code transcript: one turn with one tool call. */
const TRANSCRIPT_LINES = [
  {
    type: "user",
    uuid: "claude-user-turn-1",
    sessionId: SESSION_ID,
    version: "2.1.221",
    entrypoint: "cli",
    cwd: "/repo",
    gitBranch: "main",
    timestamp: "2026-08-04T10:00:00.000Z",
    message: { role: "user", content: "List the files." },
  },
  {
    type: "assistant",
    uuid: "claude-assistant-tool-1",
    sessionId: SESSION_ID,
    version: "2.1.221",
    cwd: "/repo",
    gitBranch: "main",
    timestamp: "2026-08-04T10:00:01.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "Bash",
          input: { command: "ls" },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "claude-tool-result-1",
    sessionId: SESSION_ID,
    version: "2.1.221",
    cwd: "/repo",
    gitBranch: "main",
    timestamp: "2026-08-04T10:00:02.000Z",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "README.md" },
      ],
    },
  },
  {
    type: "assistant",
    uuid: "claude-assistant-text-1",
    sessionId: SESSION_ID,
    version: "2.1.221",
    cwd: "/repo",
    gitBranch: "main",
    timestamp: "2026-08-04T10:00:03.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text: "There is one file: README.md." }],
    },
  },
];

let home: string;
let transcriptPath: string;

async function seedConsent(config: Record<string, unknown>): Promise<void> {
  await mkdir(join(home, ".introspection"), { recursive: true });
  await writeFile(
    join(home, ".introspection", "telemetry.json"),
    JSON.stringify(config),
  );
}

async function seedLogin(
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(join(home, ".introspection"), { recursive: true });
  await writeFile(
    join(home, ".introspection", "credentials.json"),
    JSON.stringify({
      version: 2,
      cp_url: "https://cp.example.test",
      dp_url: "https://dp.example.test",
      cp_session: "session-secret",
      org_id: "org-1",
      access_token: "at-secret",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      scope: "*",
      ...overrides,
    }),
  );
}

async function runCapture(exporter: RetainingExporter) {
  await activateForTest("claude-code", SESSION_ID, transcriptPath);
  return capture({
    host: "claude-code",
    sessionId: SESSION_ID,
    transcriptPath,
    home,
    exporterOverride: exporter,
  });
}

async function activateForTest(
  host: "claude-code" | "codex",
  sessionId: string,
  path: string,
) {
  await requestCaptureActivation({
    host,
    sessionId,
    home,
  });
  return materializeCaptureActivation({
    host,
    sessionId,
    transcriptPath: path,
    home,
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "introspection-capture-"));
  transcriptPath = join(home, "transcript.jsonl");
  await writeFile(
    transcriptPath,
    `${TRANSCRIPT_LINES.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
  delete process.env.INTROSPECTION_PLUGIN_TELEMETRY;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
});

afterEach(async () => {
  delete process.env.INTROSPECTION_PLUGIN_TELEMETRY;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CODEX_THREAD_ID;
  await rm(home, { recursive: true, force: true });
});

describe("consent gating", () => {
  it("captures nothing when no consent file exists", async () => {
    await seedLogin();
    const exporter = new RetainingExporter();

    const result = await runCapture(exporter);

    expect(result.outcome).toBe("no-consent");
    expect(exporter.kept).toHaveLength(0);
  });

  it("captures nothing when consent is explicitly disabled", async () => {
    await seedConsent({
      version: 1,
      enabled: false,
      content: "off",
      targets: [],
    });
    await seedLogin();
    const exporter = new RetainingExporter();

    const result = await runCapture(exporter);

    expect(result.outcome).toBe("no-consent");
    expect(exporter.kept).toHaveLength(0);
  });

  it("treats a malformed consent file as disabled", async () => {
    await mkdir(join(home, ".introspection"), { recursive: true });
    await writeFile(
      join(home, ".introspection", "telemetry.json"),
      "{not json",
    );
    await seedLogin();

    const config = await resolveTelemetryConfig(home);

    expect(config.enabled).toBe(false);
  });

  it("refuses a consent file written by a newer schema version", async () => {
    await seedConsent({
      version: 99,
      enabled: true,
      content: "full",
      targets: [],
    });

    const config = await resolveTelemetryConfig(home);

    expect(config.enabled).toBe(false);
  });

  it("does not capture a host outside the consented targets", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "on",
      targets: ["codex"],
    });
    await seedLogin();
    const exporter = new RetainingExporter();

    const result = await runCapture(exporter);

    expect(result.outcome).toBe("host-not-covered");
    expect(exporter.kept).toHaveLength(0);
  });

  it("covers every installed host when consent recorded no targets", () => {
    const config = {
      version: 1,
      enabled: true,
      content: "on" as const,
      targets: [],
    };

    expect(coversHost(config, "claude-code")).toBe(true);
    expect(coversHost(config, "codex")).toBe(true);
  });
});

describe("telemetry override", () => {
  it("disables capture even when the file consented", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "full",
      targets: ["claude-code"],
    });
    process.env.INTROSPECTION_PLUGIN_TELEMETRY = "off";

    const config = await resolveTelemetryConfig(home);

    expect(config.enabled).toBe(false);
    expect(config.content).toBe("off");
  });

  it("does not widen content past what was consented to", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "on",
      targets: ["claude-code"],
    });
    process.env.INTROSPECTION_PLUGIN_TELEMETRY = "on";

    const config = await resolveTelemetryConfig(home);

    expect(config.content).toBe("on");
  });

  it("lands on the floor, never full, when enabling with no stored consent", async () => {
    process.env.INTROSPECTION_PLUGIN_TELEMETRY = "on";

    const config = await resolveTelemetryConfig(home);

    expect(config.content).toBe("on");
  });

  it("does not let a full override widen metadata-only consent", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "on",
      targets: ["claude-code"],
    });
    process.env.INTROSPECTION_PLUGIN_TELEMETRY = "full";

    const config = await resolveTelemetryConfig(home);

    expect(config.enabled).toBe(true);
    expect(config.content).toBe("on");
  });

  it("does not let a full override create consent", async () => {
    process.env.INTROSPECTION_PLUGIN_TELEMETRY = "full";

    const config = await resolveTelemetryConfig(home);

    expect(config.enabled).toBe(true);
    expect(config.content).toBe("on");
  });

  it("ignores an unrecognized value rather than reading it as on", () => {
    expect(readTelemetryOverride("maybe")).toBeUndefined();
    expect(readTelemetryOverride("off")).toEqual({
      enabled: false,
      content: "off",
    });
    expect(readTelemetryOverride("full")).toEqual({
      enabled: true,
      content: "full",
    });
  });
});

describe("login profile", () => {
  it("declines an expired access token", async () => {
    await seedLogin({ expires_at: Math.floor(Date.now() / 1000) - 1 });

    expect(await loadLoginProfile(home)).toBeUndefined();
  });

  it("declines a token inside the expiry skew", async () => {
    await seedLogin({ expires_at: Math.floor(Date.now() / 1000) + 30 });

    expect(await loadLoginProfile(home)).toBeUndefined();
  });

  it("reports not-logged-in rather than exporting anonymously", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "on",
      targets: ["claude-code"],
    });
    const exporter = new RetainingExporter();

    const result = await runCapture(exporter);

    expect(result.outcome).toBe("not-logged-in");
    expect(exporter.kept).toHaveLength(0);
  });
});

describe("span construction", () => {
  beforeEach(async () => {
    await seedLogin();
  });

  it("builds a parented turn / chat / tool tree with host identity", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "on",
      targets: ["claude-code"],
    });
    const exporter = new RetainingExporter();

    const result = await runCapture(exporter);

    expect(result.outcome).toBe("exported");

    const root = exporter.kept.find(
      (s) => s.name === "invoke_agent claude-code",
    );
    expect(root).toBeDefined();
    expect(root!.attributes["gen_ai.provider.name"]).toBe("anthropic");
    expect(root!.attributes["gen_ai.operation.name"]).toBe("invoke_agent");
    expect(root!.attributes["gen_ai.conversation.id"]).toBe(SESSION_ID);
    expect(root!.attributes["gen_ai.response.id"]).toMatch(
      /^ca_v1_[0-9a-f]{64}$/,
    );
    expect(root!.attributes["gen_ai.response.id"]).toBe(
      responseIdForTurn("claude-code", SESSION_ID, "claude-user-turn-1"),
    );
    expect(root!.attributes["introspection.plugin.cwd"]).toBe("/repo");
    expect(root!.attributes["introspection.plugin.git_branch"]).toBe("main");

    // The plugin discriminator and the host version are the correlation keys the
    // platform reads; assert them explicitly rather than trusting the resource.
    expect(root!.resource.attributes["service.name"]).toBe(
      "introspection-plugin",
    );
    expect(root!.resource.attributes["introspection.plugin.host"]).toBe(
      "claude-code",
    );
    expect(root!.resource.attributes["introspection.plugin.host_version"]).toBe(
      "2.1.221",
    );

    const rootSpanId = root!.spanContext().spanId;
    const children = exporter.kept.filter((s) => s !== root);
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(child.parentSpanContext?.spanId).toBe(rootSpanId);
      expect(child.attributes["gen_ai.response.id"]).toBeUndefined();
    }

    const tool = exporter.kept.find((s) => s.name === "execute_tool Bash");
    expect(tool?.attributes["gen_ai.tool.name"]).toBe("Bash");
    expect(tool?.attributes["gen_ai.tool.call.id"]).toBe("toolu_1");
  });

  it("uses transcript timestamps, not capture time", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "on",
      targets: ["claude-code"],
    });
    const exporter = new RetainingExporter();

    await runCapture(exporter);

    const root = exporter.kept.find(
      (s) => s.name === "invoke_agent claude-code",
    );
    const startMs = root!.startTime[0] * 1000 + root!.startTime[1] / 1e6;

    expect(new Date(startMs).toISOString()).toBe("2026-08-04T10:00:00.000Z");
  });

  it("omits all message and tool content at the `on` level", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "on",
      targets: ["claude-code"],
    });
    const exporter = new RetainingExporter();

    await runCapture(exporter);

    const contentKeys = [
      "gen_ai.input.messages",
      "gen_ai.output.messages",
      "gen_ai.tool.call.arguments",
      "gen_ai.tool.call.result",
    ];
    for (const span of exporter.kept) {
      for (const key of contentKeys) {
        expect(span.attributes[key]).toBeUndefined();
      }
    }
  });

  it("includes content only at the full level, as GenAI messages", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "full",
      targets: ["claude-code"],
    });
    const exporter = new RetainingExporter();

    await runCapture(exporter);

    const root = exporter.kept.find(
      (s) => s.name === "invoke_agent claude-code",
    );

    const input = JSON.parse(String(root!.attributes["gen_ai.input.messages"]));
    expect(input).toEqual([
      { role: "user", parts: [{ type: "text", content: "List the files." }] },
    ]);

    const output = JSON.parse(
      String(root!.attributes["gen_ai.output.messages"]),
    );

    // The tool call keeps its id and structured arguments, so the linkage that
    // makes a trajectory reconstructable survives the translation.
    expect(output).toContainEqual({
      role: "assistant",
      parts: [
        {
          type: "tool_call",
          id: "toolu_1",
          name: "Bash",
          arguments: { command: "ls" },
        },
      ],
    });
    expect(output).toContainEqual({
      role: "tool",
      parts: [
        { type: "tool_call_response", id: "toolu_1", response: "README.md" },
      ],
    });
  });

  it("keeps tool payloads off the tool span, where nothing encrypts them", async () => {
    // The processor encrypts a closed set of GenAI attributes. Content on
    // `gen_ai.tool.call.arguments` / `.result` would land in ClickHouse in the
    // clear, so it must live in the messages instead — even at `full`.
    await seedConsent({
      version: 1,
      enabled: true,
      content: "full",
      targets: ["claude-code"],
    });
    const exporter = new RetainingExporter();

    await runCapture(exporter);

    const tool = exporter.kept.find((s) => s.name === "execute_tool Bash");
    expect(tool!.attributes["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(tool!.attributes["gen_ai.tool.call.result"]).toBeUndefined();
    // Identity and timing still ride on the span.
    expect(tool!.attributes["gen_ai.tool.call.id"]).toBe("toolu_1");
    expect(tool!.attributes["gen_ai.tool.name"]).toBe("Bash");
  });
});

describe("native turn segmentation and response identity", () => {
  beforeEach(async () => {
    await seedLogin();
  });

  it("emits two Claude roots for a two-turn first capture", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "full",
      targets: ["claude-code"],
    });
    const secondTurn = [
      {
        type: "user",
        uuid: "claude-user-turn-2",
        sessionId: SESSION_ID,
        version: "2.1.221",
        cwd: "/repo",
        gitBranch: "feature/turns",
        timestamp: "2026-08-04T10:01:00.000Z",
        message: { role: "user", content: "Summarize it." },
      },
      {
        // Claude writes system/continuation material as user records. It is not
        // a human boundary and must not become captured input content.
        type: "user",
        uuid: "claude-meta-1",
        isMeta: true,
        sessionId: SESSION_ID,
        version: "2.1.221",
        timestamp: "2026-08-04T10:01:00.100Z",
        message: { role: "user", content: "internal continuation context" },
      },
      {
        type: "assistant",
        uuid: "claude-assistant-text-2",
        sessionId: SESSION_ID,
        version: "2.1.221",
        cwd: "/repo",
        gitBranch: "feature/turns",
        timestamp: "2026-08-04T10:01:01.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "One file was found." }],
        },
      },
    ];
    await activateForTest("claude-code", SESSION_ID, transcriptPath);
    await writeFile(
      transcriptPath,
      `${[...TRANSCRIPT_LINES, ...secondTurn]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );
    const exporter = new RetainingExporter();

    const result = await capture({
      host: "claude-code",
      sessionId: SESSION_ID,
      transcriptPath,
      home,
      exporterOverride: exporter,
    });

    expect(result.outcome).toBe("exported");
    const roots = exporter.kept.filter(
      (span) => span.name === "invoke_agent claude-code",
    );
    expect(roots).toHaveLength(2);
    expect(
      new Set(roots.map((root) => root.attributes["gen_ai.response.id"])).size,
    ).toBe(2);
    expect(
      JSON.parse(String(roots[1]!.attributes["gen_ai.input.messages"])),
    ).toEqual([
      { role: "user", parts: [{ type: "text", content: "Summarize it." }] },
    ]);
    expect(roots[1]!.attributes["introspection.plugin.git_branch"]).toBe(
      "feature/turns",
    );
  });

  it("namespaces the same Claude turn UUID by conversation", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "on",
      targets: ["claude-code"],
    });
    const first = new RetainingExporter();
    expect((await runCapture(first)).outcome).toBe("exported");
    const firstId = first.kept.find(
      (span) => span.name === "invoke_agent claude-code",
    )?.attributes["gen_ai.response.id"];

    const otherSession = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await writeFile(
      transcriptPath,
      `${TRANSCRIPT_LINES.map((line) =>
        JSON.stringify({ ...line, sessionId: otherSession }),
      ).join("\n")}\n`,
    );
    const second = new RetainingExporter();
    await activateForTest("claude-code", otherSession, transcriptPath);
    const result = await capture({
      host: "claude-code",
      sessionId: otherSession,
      transcriptPath,
      home,
      exporterOverride: second,
    });
    expect(result.outcome).toBe("exported");
    const secondId = second.kept.find(
      (span) => span.name === "invoke_agent claude-code",
    )?.attributes["gen_ai.response.id"];

    expect(secondId).not.toBe(firstId);
  });

  it("groups Codex records by native turn_id, including repeated context", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "full",
      targets: ["codex"],
    });
    const codexSession = "codex-session-1";
    const codexLines = [
      {
        timestamp: "2026-08-04T11:00:00.000Z",
        type: "session_meta",
        payload: {
          id: codexSession,
          cwd: "/repo",
          cli_version: "0.147.0-alpha.1.2",
          originator: "codex_cli_rs",
          git: { branch: "feature/turns" },
        },
      },
      {
        timestamp: "2026-08-04T11:00:01.000Z",
        type: "turn_context",
        payload: { turn_id: "turn-native-1", cwd: "/repo", model: "gpt-5" },
      },
      {
        timestamp: "2026-08-04T11:00:01.100Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "First question" }],
        },
      },
      {
        timestamp: "2026-08-04T11:00:02.000Z",
        type: "turn_context",
        payload: { turn_id: "turn-native-1", cwd: "/repo", model: "gpt-5" },
      },
      {
        timestamp: "2026-08-04T11:00:03.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "First answer" }],
        },
      },
      {
        timestamp: "2026-08-04T11:00:04.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-native-1" },
      },
      {
        timestamp: "2026-08-04T11:01:00.000Z",
        type: "turn_context",
        payload: { turn_id: "turn-native-2", cwd: "/repo", model: "gpt-5" },
      },
      {
        timestamp: "2026-08-04T11:01:00.100Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Second question" }],
        },
      },
      {
        timestamp: "2026-08-04T11:01:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Second answer" }],
        },
      },
      {
        timestamp: "2026-08-04T11:01:02.000Z",
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "turn-native-2" },
      },
    ];
    // Activation happens while the Introspection-owned loader is running in the
    // first turn. Later Stop capture may then consume this and following turns.
    await writeFile(
      transcriptPath,
      `${codexLines
        .slice(0, 2)
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );
    expect(
      (await activateForTest("codex", codexSession, transcriptPath)).outcome,
    ).toBe("activated");
    await writeFile(
      transcriptPath,
      `${codexLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    const exporter = new RetainingExporter();

    const result = await capture({
      host: "codex",
      sessionId: codexSession,
      transcriptPath,
      home,
      exporterOverride: exporter,
      finalizeTrailingTurn: false,
    });

    expect(result.outcome).toBe("exported");
    const roots = exporter.kept.filter(
      (span) => span.name === "invoke_agent codex",
    );
    expect(roots).toHaveLength(2);
    expect(
      new Set(roots.map((root) => root.attributes["gen_ai.response.id"])).size,
    ).toBe(2);
    expect(roots[0]!.attributes["introspection.plugin.cwd"]).toBe("/repo");
    expect(roots[0]!.attributes["introspection.plugin.git_branch"]).toBe(
      "feature/turns",
    );
    expect(roots[0]!.attributes["gen_ai.response.id"]).toBe(
      responseIdForTurn("codex", codexSession, "turn-native-1"),
    );
    expect(
      JSON.parse(String(roots[0]!.attributes["gen_ai.input.messages"])),
    ).toEqual([
      { role: "user", parts: [{ type: "text", content: "First question" }] },
    ]);
    expect(
      JSON.parse(String(roots[1]!.attributes["gen_ai.output.messages"])),
    ).toContainEqual({
      role: "assistant",
      parts: [{ type: "text", content: "Second answer" }],
      provider: "openai",
      model: "gpt-5",
    });
  });

  it("keeps Claude parent sidechains excluded on continuation chunks", () => {
    const sidechainOnly = [
      {
        type: "user",
        uuid: "sidechain-user",
        isSidechain: true,
        sessionId: SESSION_ID,
        message: { role: "user", content: "Subagent prompt" },
      },
      {
        type: "assistant",
        uuid: "sidechain-assistant",
        isSidechain: true,
        sessionId: SESSION_ID,
        message: { role: "assistant", content: "Subagent answer" },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");

    expect(
      segmentTranscript("claude-code", `${sidechainOnly}\n`).turns,
    ).toHaveLength(1);
    expect(
      segmentTranscript("claude-code", `${sidechainOnly}\n`, {
        claudeStandaloneSidechain: false,
      }).turns,
    ).toHaveLength(0);
  });
});

describe("shared per-session activation", () => {
  it("maps only authoritative host subprocess identities into requests", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "full",
      targets: ["claude-code", "codex"],
    });

    process.env.CLAUDE_CODE_SESSION_ID = SESSION_ID;
    expect((await requestCaptureActivationFromEnvironment(home)).outcome).toBe(
      "requested",
    );
    await clearCaptureActivationRequest("claude-code", SESSION_ID, home);

    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CODEX_THREAD_ID = "codex-native-thread";
    expect((await requestCaptureActivationFromEnvironment(home)).outcome).toBe(
      "requested",
    );

    process.env.CLAUDE_CODE_SESSION_ID = SESSION_ID;
    expect((await requestCaptureActivationFromEnvironment(home)).outcome).toBe(
      "source-invalid",
    );
  });

  it("keeps Claude inert until a loader request is bound by its hook", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "full",
      targets: ["claude-code"],
    });
    await seedLogin();
    const before = await capture({
      host: "claude-code",
      sessionId: SESSION_ID,
      transcriptPath,
      home,
      exporterOverride: new RetainingExporter(),
    });
    expect(before.outcome).toBe("not-activated");

    expect(
      (
        await requestCaptureActivation({
          host: "claude-code",
          sessionId: SESSION_ID,
          home,
        })
      ).outcome,
    ).toBe("requested");
    const result = await runHook(
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
      }),
      "claude-code",
      { dryRun: true, home },
    );
    expect(result.outcome).toBe("exported");
    const marker = await readCaptureActivation(
      "claude-code",
      SESSION_ID,
      transcriptPath,
      home,
    );
    expect(marker?.nativeTurnKey).toBe("claude-user-turn-1");
  });

  it("does not advance the checkpoint after the hook deadline", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "full",
      targets: ["claude-code"],
    });
    await seedLogin();
    await requestCaptureActivation({
      host: "claude-code",
      sessionId: SESSION_ID,
      home,
    });

    const result = await runHook(
      JSON.stringify({
        hook_event_name: "Stop",
        session_id: SESSION_ID,
        transcript_path: transcriptPath,
      }),
      "claude-code",
      {
        home,
        deadlineMs: 5,
        exporterOverride: new DelayedRetainingExporter(50),
      },
    );

    expect(result.outcome).toBe("export-failed");
    expect(result.detail).toContain("exceeded 5ms");

    // Let the abandoned exporter finish. The aborted capture must still leave
    // the turn unread so the next lifecycle hook retries it.
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(
      (
        await readCaptureState(
          captureStatePath("claude-code", SESSION_ID, home),
        )
      ).byteOffset,
    ).toBe(0);
  });

  it("discards an unbound Claude request at the next session start", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "full",
      targets: ["claude-code"],
    });
    expect(
      (
        await requestCaptureActivation({
          host: "claude-code",
          sessionId: SESSION_ID,
          home,
        })
      ).outcome,
    ).toBe("requested");

    const result = await runHook(
      JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: SESSION_ID,
        transcript_path: null,
      }),
      "claude-code",
      { dryRun: true, home },
    );
    expect(result.outcome).toBe("no-new-records");
    expect(
      (
        await materializeCaptureActivation({
          host: "claude-code",
          sessionId: SESSION_ID,
          transcriptPath,
          home,
        })
      ).outcome,
    ).toBe("request-missing");
  });

  it("does not bind a pending request after consent is revoked", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "full",
      targets: ["claude-code"],
    });
    expect(
      (
        await requestCaptureActivation({
          host: "claude-code",
          sessionId: SESSION_ID,
          home,
        })
      ).outcome,
    ).toBe("requested");
    await seedConsent({
      version: 1,
      enabled: false,
      content: "full",
      targets: ["claude-code"],
    });

    expect(
      (
        await runHook(
          JSON.stringify({
            hook_event_name: "Stop",
            session_id: SESSION_ID,
            transcript_path: transcriptPath,
          }),
          "claude-code",
          { dryRun: true, home },
        )
      ).outcome,
    ).toBe("no-consent");

    await seedConsent({
      version: 1,
      enabled: true,
      content: "full",
      targets: ["claude-code"],
    });
    expect(
      (
        await materializeCaptureActivation({
          host: "claude-code",
          sessionId: SESSION_ID,
          transcriptPath,
          home,
        })
      ).outcome,
    ).toBe("request-missing");
  });
});

describe("Codex shared activation adapter", () => {
  const codexSession = "019fd200-0000-7000-8000-000000000001";
  const codexPrefix = [
    {
      timestamp: "2026-08-04T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: codexSession,
        cwd: "/repo",
        cli_version: "0.147.0-alpha.1.2",
        originator: "codex_cli_rs",
      },
    },
    {
      timestamp: "2026-08-04T11:59:00.000Z",
      type: "turn_context",
      payload: { turn_id: "unrelated-turn", cwd: "/repo", model: "gpt-5" },
    },
    {
      timestamp: "2026-08-04T11:59:00.100Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Unrelated prompt" }],
      },
    },
    {
      timestamp: "2026-08-04T11:59:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Unrelated answer" }],
      },
    },
    {
      timestamp: "2026-08-04T11:59:02.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "unrelated-turn" },
    },
    {
      timestamp: "2026-08-04T12:00:01.000Z",
      type: "turn_context",
      payload: { turn_id: "codex-turn-1", cwd: "/repo", model: "gpt-5" },
    },
  ];
  const codexTurn = [
    {
      timestamp: "2026-08-04T12:00:01.100Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Activated prompt" }],
      },
    },
    {
      timestamp: "2026-08-04T12:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Activated answer" }],
      },
    },
    {
      timestamp: "2026-08-04T12:00:03.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "codex-turn-1" },
    },
  ];

  async function writeCodex(lines: unknown[]): Promise<void> {
    await writeFile(
      transcriptPath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
  }

  beforeEach(async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "full",
      targets: ["codex"],
    });
    await seedLogin();
    await writeCodex([...codexPrefix, ...codexTurn]);
  });

  it("is inert when the matching activation marker is absent", async () => {
    const exporter = new RetainingExporter();

    const result = await capture({
      host: "codex",
      sessionId: codexSession,
      transcriptPath,
      home,
      exporterOverride: exporter,
    });

    expect(result.outcome).toBe("not-activated");
    expect(exporter.kept).toHaveLength(0);
  });

  it("creates an atomic private marker at the current turn boundary", async () => {
    const result = await activateForTest("codex", codexSession, transcriptPath);

    expect(result.outcome).toBe("activated");
    expect(result.marker?.nativeTurnKey).toBe("codex-turn-1");
    expect(result.marker?.byteOffset).toBeGreaterThan(0);
    const path = captureActivationPath(
      "codex",
      codexSession,
      result.marker!.transcriptIdentity,
      home,
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(
      await readCaptureActivation("codex", codexSession, transcriptPath, home),
    ).toEqual(result.marker);
  });

  it("does not let one activated session authorize an unrelated session", async () => {
    await activateForTest("codex", codexSession, transcriptPath);

    const result = await capture({
      host: "codex",
      sessionId: "019fd200-0000-7000-8000-000000000099",
      transcriptPath,
      home,
      exporterOverride: new RetainingExporter(),
    });

    expect(result.outcome).toBe("not-activated");
  });

  it("does not let an activated thread authorize a copied rollout", async () => {
    expect(
      (await activateForTest("codex", codexSession, transcriptPath)).outcome,
    ).toBe("activated");
    const copied = join(home, "copied-rollout.jsonl");
    await writeFile(
      copied,
      `${[...codexPrefix, ...codexTurn]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );

    const result = await capture({
      host: "codex",
      sessionId: codexSession,
      transcriptPath: copied,
      home,
      exporterOverride: new RetainingExporter(),
    });

    expect(result.outcome).toBe("not-activated");
  });

  it("preserves the first boundary across repeated loader execution and replay", async () => {
    const firstActivation = await activateForTest(
      "codex",
      codexSession,
      transcriptPath,
    );
    const first = new RetainingExporter();
    expect(
      (
        await capture({
          host: "codex",
          sessionId: codexSession,
          transcriptPath,
          home,
          exporterOverride: first,
        })
      ).outcome,
    ).toBe("exported");
    const roots = first.kept.filter(
      (span) => span.name === "invoke_agent codex",
    );
    expect(roots).toHaveLength(1);
    expect(roots[0]?.attributes["gen_ai.response.id"]).toBe(
      responseIdForTurn("codex", codexSession, "codex-turn-1"),
    );
    expect(
      JSON.parse(String(roots[0]?.attributes["gen_ai.input.messages"])),
    ).toEqual([
      { role: "user", parts: [{ type: "text", content: "Activated prompt" }] },
    ]);

    const secondActivation = await activateForTest(
      "codex",
      codexSession,
      transcriptPath,
    );
    expect(secondActivation.marker?.byteOffset).toBe(
      firstActivation.marker?.byteOffset,
    );
    const replay = new RetainingExporter();
    const replayResult = await capture({
      host: "codex",
      sessionId: codexSession,
      transcriptPath,
      home,
      exporterOverride: replay,
    });
    expect(replayResult.outcome).toBe("no-new-records");
    expect(replay.kept).toHaveLength(0);
  });

  it("honors metadata-only consent after activation", async () => {
    await seedConsent({
      version: 1,
      enabled: true,
      content: "on",
      targets: ["codex"],
    });
    await activateForTest("codex", codexSession, transcriptPath);
    const exporter = new RetainingExporter();

    expect(
      (
        await capture({
          host: "codex",
          sessionId: codexSession,
          transcriptPath,
          home,
          exporterOverride: exporter,
        })
      ).outcome,
    ).toBe("exported");
    const root = exporter.kept.find(
      (span) => span.name === "invoke_agent codex",
    );
    expect(root?.attributes["gen_ai.response.id"]).toBe(
      responseIdForTurn("codex", codexSession, "codex-turn-1"),
    );
    expect(root?.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(root?.attributes["gen_ai.output.messages"]).toBeUndefined();
  });
});

describe("incremental checkpointing", () => {
  beforeEach(async () => {
    await seedLogin();
    await seedConsent({
      version: 1,
      enabled: true,
      content: "on",
      targets: ["claude-code"],
    });
  });

  it("does not re-export a transcript that has not grown", async () => {
    const first = new RetainingExporter();
    await runCapture(first);
    expect(first.kept.length).toBeGreaterThan(0);

    const second = new RetainingExporter();
    const result = await runCapture(second);

    expect(result.outcome).toBe("no-new-records");
    expect(second.kept).toHaveLength(0);
  });

  it("replays safely when migrating a v1 chunk checkpoint", async () => {
    const directory = join(
      home,
      ".introspection",
      "capture-state",
      "claude-code",
    );
    await mkdir(directory, { recursive: true });
    await activateForTest("claude-code", SESSION_ID, transcriptPath);
    const marker = await readCaptureActivation(
      "claude-code",
      SESSION_ID,
      transcriptPath,
      home,
    );
    const statePath = captureStatePath(
      "claude-code",
      SESSION_ID,
      home,
      marker!.transcriptIdentity,
    );
    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        byteOffset: Buffer.byteLength(
          `${TRANSCRIPT_LINES.map((line) => JSON.stringify(line)).join("\n")}\n`,
          "utf8",
        ),
        turn: 1,
      }),
    );
    const exporter = new RetainingExporter();

    const result = await runCapture(exporter);

    expect(result.outcome).toBe("exported");
    expect(
      exporter.kept.find((span) => span.name === "invoke_agent claude-code")
        ?.attributes["gen_ai.response.id"],
    ).toMatch(/^ca_v1_[0-9a-f]{64}$/);
    const migrated = await readCaptureState(statePath);
    expect(migrated.version).toBe(2);
    expect(migrated.turn).toBe(1);
  });

  it("exports only the true turn appended since the last run", async () => {
    await runCapture(new RetainingExporter());

    await writeFile(
      transcriptPath,
      `${TRANSCRIPT_LINES.map((l) => JSON.stringify(l)).join("\n")}\n${JSON.stringify(
        {
          type: "user",
          uuid: "claude-user-turn-2",
          sessionId: SESSION_ID,
          version: "2.1.221",
          timestamp: "2026-08-04T10:00:10.000Z",
          message: { role: "user", content: "What next?" },
        },
      )}\n${JSON.stringify({
        type: "assistant",
        uuid: "claude-assistant-text-2",
        sessionId: SESSION_ID,
        version: "2.1.221",
        timestamp: "2026-08-04T10:00:11.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "Anything else?" }],
        },
      })}\n`,
    );

    const exporter = new RetainingExporter();
    const result = await runCapture(exporter);

    expect(result.outcome).toBe("exported");
    expect(
      exporter.kept.filter((s) => s.name === "invoke_agent claude-code"),
    ).toHaveLength(1);
    // The single new assistant message was exported, not the previous turn.
    expect(
      exporter.kept.filter((s) => s.name.startsWith("chat ")),
    ).toHaveLength(1);
  });

  it("holds an unfinished Claude turn and re-reads it from its boundary", async () => {
    const unfinished = `${TRANSCRIPT_LINES.slice(0, 3)
      .map((line) => JSON.stringify(line))
      .join("\n")}\n`;
    await writeFile(transcriptPath, unfinished);

    const first = new RetainingExporter();
    await activateForTest("claude-code", SESSION_ID, transcriptPath);
    const pending = await capture({
      host: "claude-code",
      sessionId: SESSION_ID,
      transcriptPath,
      home,
      exporterOverride: first,
      finalizeTrailingTurn: false,
    });

    expect(pending.outcome).toBe("no-new-records");
    expect(first.kept).toHaveLength(0);
    expect(
      (
        await readCaptureState(
          captureStatePath("claude-code", SESSION_ID, home),
        )
      ).byteOffset,
    ).toBe(0);

    await writeFile(
      transcriptPath,
      `${TRANSCRIPT_LINES.map((line) => JSON.stringify(line)).join("\n")}\n`,
    );
    const completed = new RetainingExporter();
    const result = await runCapture(completed);

    expect(result.outcome).toBe("exported");
    const root = completed.kept.find(
      (span) => span.name === "invoke_agent claude-code",
    );
    expect(root?.attributes["gen_ai.response.id"]).toMatch(
      /^ca_v1_[0-9a-f]{64}$/,
    );
    expect(
      completed.kept.find((span) => span.name === "execute_tool Bash"),
    ).toBeDefined();
  });

  it("uses the same response ID when a failed export re-reads the turn", async () => {
    const failedExporter = new FailingRetainingExporter();
    await activateForTest("claude-code", SESSION_ID, transcriptPath);
    const failed = await capture({
      host: "claude-code",
      sessionId: SESSION_ID,
      transcriptPath,
      home,
      exporterOverride: failedExporter,
    });
    expect(failed.outcome).toBe("export-failed");
    const firstId = failedExporter.kept.find(
      (span) => span.name === "invoke_agent claude-code",
    )?.attributes["gen_ai.response.id"];

    const retry = new RetainingExporter();
    expect((await runCapture(retry)).outcome).toBe("exported");
    const retryId = retry.kept.find(
      (span) => span.name === "invoke_agent claude-code",
    )?.attributes["gen_ai.response.id"];

    expect(retryId).toBe(firstId);
  });

  it("does not advance the checkpoint when the export fails", async () => {
    // The guarantee under test: a failed delivery must cost a re-sent turn, not
    // a silently skipped one. OTel makes this easy to get wrong — export errors
    // go to its global error handler and `shutdown()` resolves regardless, so a
    // dead collector looks exactly like success unless the result code is read.
    const failing: SpanExporter = {
      export(_spans, resultCallback) {
        resultCallback({
          code: ExportResultCode.FAILED,
          error: new Error("collector unreachable"),
        });
      },
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    };

    await activateForTest("claude-code", SESSION_ID, transcriptPath);
    const failed = await capture({
      host: "claude-code",
      sessionId: SESSION_ID,
      transcriptPath,
      home,
      exporterOverride: failing,
    });

    expect(failed.outcome).toBe("export-failed");

    // The same records must still be there for the next run.
    const retry = new RetainingExporter();
    const result = await runCapture(retry);

    expect(result.outcome).toBe("exported");
    expect(retry.kept.length).toBeGreaterThan(0);
  });

  it("ignores a trailing partially-written line", async () => {
    const complete = `${TRANSCRIPT_LINES.map((l) => JSON.stringify(l)).join("\n")}\n`;
    await writeFile(transcriptPath, `${complete}{"type":"assist`);

    const exporter = new RetainingExporter();
    const result = await runCapture(exporter);

    expect(result.outcome).toBe("exported");
    // The checkpoint must stop at the last newline so the half-line is re-read
    // in full next time rather than parsed as garbage.
    expect(result.bytesRead).toBe(Buffer.byteLength(complete, "utf8"));
  });

  it("restarts from zero when the transcript shrinks", async () => {
    await runCapture(new RetainingExporter());

    await writeFile(
      transcriptPath,
      `${JSON.stringify(TRANSCRIPT_LINES[0])}\n${JSON.stringify(TRANSCRIPT_LINES[3])}\n`,
    );

    const exporter = new RetainingExporter();
    const result = await runCapture(exporter);

    expect(result.outcome).toBe("exported");
    expect(exporter.kept.length).toBeGreaterThan(0);
  });
});

describe("host metadata", () => {
  it("reads the Claude Code version off any conversational record", () => {
    const info = readHostInfo(
      "claude-code",
      `${JSON.stringify({ type: "user", version: "2.1.221", entrypoint: "cli" })}\n`,
    );

    expect(info).toEqual({
      host: "claude-code",
      hostVersion: "2.1.221",
      entrypoint: "cli",
    });
  });

  it("reads the Codex version off its session_meta payload", () => {
    const info = readHostInfo(
      "codex",
      `${JSON.stringify({
        type: "session_meta",
        payload: { cli_version: "0.58.0", originator: "codex_cli_rs" },
      })}\n`,
    );

    expect(info.hostVersion).toBe("0.58.0");
    expect(info.entrypoint).toBe("codex_cli_rs");
  });

  it("degrades to the host alone rather than failing on junk", () => {
    expect(readHostInfo("claude-code", "not json at all\n")).toEqual({
      host: "claude-code",
    });
  });
});

describe("hook payload parsing", () => {
  it("reads a Claude Code hook event", () => {
    expect(
      parseHookEvent({
        hook_event_name: "Stop",
        session_id: SESSION_ID,
        transcript_path: "/home/dev/.claude/projects/x/abc.jsonl",
        cwd: "/repo",
      }),
    ).toEqual({
      host: "claude-code",
      sessionId: SESSION_ID,
      transcriptPath: "/home/dev/.claude/projects/x/abc.jsonl",
      hookEventName: "Stop",
    });
  });

  it("reads a Codex hook event", () => {
    expect(
      parseHookEvent({
        hook_event_name: "Stop",
        session_id: "thread-9",
        transcript_path:
          "/home/dev/.codex/sessions/2026/08/04/rollout-thread-9.jsonl",
        turn_id: "turn-4",
      }),
    ).toEqual({
      host: "codex",
      sessionId: "thread-9",
      transcriptPath:
        "/home/dev/.codex/sessions/2026/08/04/rollout-thread-9.jsonl",
      turnId: "turn-4",
      hookEventName: "Stop",
    });
  });

  it("falls back to the transcript stem when no session id is supplied", () => {
    expect(
      parseHookEvent({ rollout_path: "/tmp/rollout-abc.jsonl" }, "codex")
        ?.sessionId,
    ).toBe("rollout-abc");
  });

  it("rejects a payload that names no transcript", () => {
    expect(parseHookEvent({ session_id: SESSION_ID })).toBeUndefined();
    expect(parseHookEvent("not an object")).toBeUndefined();
  });
});
