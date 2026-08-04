/**
 * Capture path for the Introspection plugin's Claude Code / Codex observability.
 *
 * The consent tests carry the weight here. Everything else in this package is
 * recoverable if it misbehaves; capturing a session the user did not opt into is
 * not, so the gates are asserted from every direction — disabled, absent,
 * malformed, wrong host, and the env override in both directions.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
  coversHost,
  readTelemetryOverride,
  resolveTelemetryConfig,
} from "../../packages/introspection-coding-agent/src/config";
import { loadLoginProfile } from "../../packages/introspection-coding-agent/src/credentials";
import { readHostInfo } from "../../packages/introspection-coding-agent/src/host";
import { parseHookEvent } from "../../packages/introspection-coding-agent/src/hook";

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

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

/** A minimal but realistic Claude Code transcript: one turn with one tool call. */
const TRANSCRIPT_LINES = [
  {
    type: "user",
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
  return capture({
    host: "claude-code",
    sessionId: SESSION_ID,
    transcriptPath,
    home,
    exporterOverride: exporter,
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
});

afterEach(async () => {
  delete process.env.INTROSPECTION_PLUGIN_TELEMETRY;
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

  it("exports only the records appended since the last run", async () => {
    await runCapture(new RetainingExporter());

    await writeFile(
      transcriptPath,
      `${TRANSCRIPT_LINES.map((l) => JSON.stringify(l)).join("\n")}\n${JSON.stringify(
        {
          type: "assistant",
          sessionId: SESSION_ID,
          version: "2.1.221",
          timestamp: "2026-08-04T10:00:10.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-5",
            content: [{ type: "text", text: "Anything else?" }],
          },
        },
      )}\n`,
    );

    const exporter = new RetainingExporter();
    const result = await runCapture(exporter);

    expect(result.outcome).toBe("exported");
    // One new turn root plus the single new assistant message — not a re-send of
    // the whole transcript.
    expect(
      exporter.kept.filter((s) => s.name.startsWith("chat ")),
    ).toHaveLength(1);
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
    });
  });

  it("reads a Codex hook event", () => {
    expect(
      parseHookEvent(
        {
          thread_id: "thread-9",
          rollout_path: "/home/dev/.codex/sessions/r.jsonl",
        },
        "codex",
      ),
    ).toEqual({
      host: "codex",
      sessionId: "thread-9",
      transcriptPath: "/home/dev/.codex/sessions/r.jsonl",
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
