/**
 * Contract conformance — the vendored platform snapshot in `contracts/`
 * (OpenAPI docs + wire fixtures, see `contracts/README.md`) checked against
 * the SDK's public types and parsers. Fixtures are the platform's truth:
 * when the SDK and a fixture disagree, the SDK adapts or the mismatch gets
 * reported upstream — fixtures are never edited to make tests pass (the
 * manifest sha256 check below turns a hand-edited fixture into a failure).
 *
 * KNOWN MISMATCHES (encoded as tripwire tests below so a fix on either side
 * flips the test and prompts removing the entry):
 *
 * 1. `Task` — the SDK declares a required `mode: TaskMode` (10-value enum);
 *    the platform `Task` schema instead has `kind: TaskKind`
 *    (`"agent" | "process"`). The fixture carries `kind`, not `mode`.
 * 2. `RunnerSpec.runtime_context` — the SDK's `RunnerContext` declares a
 *    required nested `recipe: RunnerRecipeSummary` and required non-null
 *    `runtime_id` / `recipe_id`; the platform `RunnerContextSummary`
 *    flattens the recipe pin into `recipe_repository_id` / `recipe_git_ref`
 *    / `recipe_git_commit_sha` (all nullable, as are `runtime_id` /
 *    `recipe_id`) and adds `runtime_group_id` + `agent_name`, which the SDK
 *    does not declare.
 * 3. `RunnerContext.caller` — SDK declares `caller?: RunCaller` (optional,
 *    never null); the platform serialises an explicit `null`.
 * 4. `ConversationItem` — the platform item carries `cost_usd` and
 *    `agent_id`, which the SDK interface does not declare (read-side gap,
 *    not a break).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConversationItemsClient,
  EventType,
  cursorPaginate,
  parseAgUiEvents,
  streamResumable,
  toApiError,
  type ResourceHttpClient,
} from "@introspection-sdk/http";
import {
  ConflictError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  type ConversationItemList,
  type Paginated,
  type TaskRun,
} from "@introspection-sdk/types";
import type { AGUIEvent } from "@ag-ui/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(__dirname, "../../contracts");

function readText(rel: string): string {
  return readFileSync(join(contractsDir, rel), "utf8");
}

function readJson(rel: string): unknown {
  return JSON.parse(readText(rel));
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(contractsDir, join(e.parentPath, e.name)))
    .sort();
}

// ── shared scalar schemas ────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Uuid = z.string().regex(UUID_RE);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

// ── manifest integrity ───────────────────────────────────────────────────

interface Manifest {
  artifacts: Record<string, { sha256: string }>;
  generated_from_commit: string;
  version: number;
}

const manifest = readJson("manifest.json") as Manifest;

/** Listed in the manifest but deliberately not vendored (internal surface). */
const NOT_VENDORED = new Set([
  "controlplane.full.v1.json",
  "dataplane.full.v1.json",
]);

/** Vendored alongside the snapshot but not a platform artifact. */
const LOCAL_FILES = new Set(["README.md", "manifest.json"]);

describe("contracts/ manifest integrity", () => {
  const vendored = Object.entries(manifest.artifacts).filter(
    ([name]) => !NOT_VENDORED.has(name),
  );

  it.each(vendored)("%s sha256 matches the manifest", (name, { sha256 }) => {
    const actual = createHash("sha256")
      .update(readFileSync(join(contractsDir, name)))
      .digest("hex");
    expect(actual).toBe(sha256);
  });

  it("every file in contracts/ is accounted for", () => {
    const files = walk(contractsDir).filter((f) => !LOCAL_FILES.has(f));
    expect(files).toEqual(
      Object.keys(manifest.artifacts)
        .filter((n) => !NOT_VENDORED.has(n))
        .sort(),
    );
  });

  it("records the generating commit", () => {
    expect(manifest.generated_from_commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ── every fixture parses ─────────────────────────────────────────────────

describe("fixtures parse", () => {
  const jsonFixtures = walk(contractsDir).filter(
    (f) => f.startsWith("fixtures/") && f.endsWith(".json"),
  );

  it.each(jsonFixtures)("%s is valid JSON", (rel) => {
    expect(() => readJson(rel)).not.toThrow();
  });

  it("fixtures/streams/run-stream.jsonl is valid JSONL", () => {
    const lines = readText("fixtures/streams/run-stream.jsonl")
      .trim()
      .split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("the vendored OpenAPI documents are valid JSON with a /v1 surface", () => {
    for (const doc of [
      "controlplane.public.v1.json",
      "dataplane.public.v1.json",
    ]) {
      const parsed = readJson(doc) as { paths: Record<string, unknown> };
      expect(Object.keys(parsed.paths).length).toBeGreaterThan(0);
    }
  });

  it("no contract exposes a runtimes activate operation", () => {
    // Guards the removal of RuntimesClient.activateById: the platform no
    // longer serves POST /v1/runtimes/{id}/activate.
    for (const doc of [
      "controlplane.public.v1.json",
      "dataplane.public.v1.json",
    ]) {
      const parsed = readJson(doc) as { paths: Record<string, unknown> };
      const activatePaths = Object.keys(parsed.paths).filter((p) =>
        p.includes("activate"),
      );
      expect(activatePaths).toEqual([]);
    }
  });
});

// ── tasks/create.response.json vs TaskCreateResponse ─────────────────────

const TaskStatusSchema = z.enum([
  "pending",
  "queued",
  "scheduled",
  "running",
  "awaiting_user",
  "idle",
  "completed",
  "failed",
  "cancelling",
  "cancelled",
]);

const AgentInfoSchema = z.object({
  sandbox_status: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
});

/**
 * The SDK `Task` interface, transliterated field-by-field — minus the
 * known-mismatch `mode` field, which is asserted separately below.
 * Non-strict on purpose: platform-only fields (`kind`) are covered by the
 * undeclared-fields tripwire.
 */
const TaskSdkSchema = z.object({
  id: Uuid,
  org_id: Uuid,
  project_id: Uuid,
  created_at: IsoDate,
  updated_at: IsoDate,
  title: z.string().nullable().optional(),
  display_index: z.number().int().nullable().optional(),
  status: TaskStatusSchema,
  member_id: Uuid.nullable().optional(),
  automation_id: Uuid.nullable().optional(),
  runtime_id: Uuid.nullable().optional(),
  is_archived: z.boolean(),
  started_at: IsoDate.nullable().optional(),
  completed_at: IsoDate.nullable().optional(),
  last_user_message_at: IsoDate.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  agent: AgentInfoSchema.nullable().optional(),
  identity_key: z.string().nullable().optional(),
});

/** Every field the SDK `Task` interface declares (including `mode`). */
const SDK_TASK_FIELDS = [...Object.keys(TaskSdkSchema.shape), "mode"];

const TaskRunSchema = z.strictObject({
  id: z.string(),
  task_id: Uuid,
  status: TaskStatusSchema,
  created_at: IsoDate.nullable().optional(),
  updated_at: IsoDate.nullable().optional(),
});

describe("fixtures/tasks/create.response.json vs TaskCreateResponse", () => {
  const fixture = readJson("fixtures/tasks/create.response.json") as {
    task: Record<string, unknown>;
    run: Record<string, unknown>;
  };

  it("has the TaskCreateResponse envelope: { task, run }", () => {
    expect(Object.keys(fixture).sort()).toEqual(["run", "task"]);
  });

  it("task carries every SDK-declared field (except `mode`) with the declared type", () => {
    expect(() => TaskSdkSchema.parse(fixture.task)).not.toThrow();
  });

  it("run decodes as the SDK TaskRun type", () => {
    // Strict + compile-time assignability: the parsed value IS a TaskRun.
    const run: TaskRun = TaskRunSchema.parse(fixture.run);
    expect(run.task_id).toBe(fixture.task.id);
    expect(run.id).toBe(
      (fixture.task.metadata as Record<string, unknown>).active_run_id,
    );
  });

  it("KNOWN MISMATCH: SDK requires Task.mode; platform Task has kind instead", () => {
    const required = [
      "id",
      "org_id",
      "project_id",
      "created_at",
      "updated_at",
      "mode",
      "status",
      "is_archived",
    ];
    const missing = required.filter((f) => !(f in fixture.task));
    expect(missing).toEqual(["mode"]);
    // Platform truth: TaskKind is "agent" | "process".
    expect(["agent", "process"]).toContain(fixture.task.kind);
  });

  it("KNOWN MISMATCH: fixture fields the SDK Task does not declare", () => {
    const undeclared = Object.keys(fixture.task).filter(
      (k) => !SDK_TASK_FIELDS.includes(k),
    );
    expect(undeclared.sort()).toEqual(["kind"]);
  });
});

// ── runners/run.response.json vs RunnerSpec ──────────────────────────────

const RunnerDeploymentSchema = z.strictObject({
  endpoint: z.string().regex(/^https:\/\//),
  slug: z.string(),
  region: z.string(),
});

const RunnerIdentitySchema = z.strictObject({
  user_id: z.string().nullable(),
  anonymous_id: z.string().nullable(),
  conversation_id: z.string().nullable(),
});

const RunnerSpecSchema = z.strictObject({
  session_id: z.string(),
  deployment: RunnerDeploymentSchema,
  session_token: z.string(),
  expires_at: IsoDate,
  runtime_context: z.record(z.string(), z.unknown()),
});

/** Every field the SDK `RunnerContext` interface declares. */
const SDK_RUNNER_CONTEXT_FIELDS = [
  "runtime_id",
  "experiment_id",
  "recipe_id",
  "recipe",
  "arm_label",
  "identity",
  "caller",
];

describe("fixtures/runners/run.response.json vs RunnerSpec", () => {
  const fixture = readJson("fixtures/runners/run.response.json") as {
    runtime_context: Record<string, unknown>;
  } & Record<string, unknown>;

  it("decodes the RunnerSpec top level: session_id, deployment{endpoint,slug,region}, session_token, expires_at, runtime_context", () => {
    expect(() => RunnerSpecSchema.parse(fixture)).not.toThrow();
  });

  it("runtime_context overlap matches the SDK RunnerContext field types", () => {
    const rc = fixture.runtime_context;
    expect(rc.runtime_id).toMatch(UUID_RE);
    expect(rc.recipe_id).toMatch(UUID_RE);
    expect(rc.experiment_id).toBeNull();
    expect(rc.arm_label).toBeNull();
    expect(() => RunnerIdentitySchema.parse(rc.identity)).not.toThrow();
  });

  it("KNOWN MISMATCH: SDK RunnerContext.recipe (nested) vs platform's flattened recipe_* fields", () => {
    const rc = fixture.runtime_context;
    // SDK declares a required nested `recipe: RunnerRecipeSummary` — absent.
    expect(rc).not.toHaveProperty("recipe");
    // Platform truth: the recipe pin is flattened.
    expect(rc).toHaveProperty("recipe_repository_id");
    expect(rc.recipe_git_ref).toEqual(expect.any(String));
    expect(rc.recipe_git_commit_sha).toEqual(expect.any(String));
  });

  it("KNOWN MISMATCH: runtime_context fields the SDK does not declare", () => {
    const undeclared = Object.keys(fixture.runtime_context).filter(
      (k) => !SDK_RUNNER_CONTEXT_FIELDS.includes(k),
    );
    expect(undeclared.sort()).toEqual([
      "agent_name",
      "recipe_git_commit_sha",
      "recipe_git_ref",
      "recipe_repository_id",
      "runtime_group_id",
    ]);
  });

  it("KNOWN MISMATCH: caller is serialised as null; SDK declares `caller?: RunCaller` (no null)", () => {
    expect(fixture.runtime_context.caller).toBeNull();
  });
});

// ── pagination/cursor-envelope.json vs Paginated<T> + cursorPaginate ─────

const CursorRecordSchema = z.strictObject({ id: Uuid, title: z.string() });
type CursorRecord = z.infer<typeof CursorRecordSchema>;

const CursorEnvelopeSchema = z.strictObject({
  records: z.array(CursorRecordSchema),
  count: z.number().int(),
  total_count: z.number().int().nullable(),
  next: z.string().nullable(),
});

describe("fixtures/pagination/cursor-envelope.json vs Paginated<T>", () => {
  // Compile-time assignability: the parsed envelope IS a Paginated<T>.
  const envelope: Paginated<CursorRecord> = CursorEnvelopeSchema.parse(
    readJson("fixtures/pagination/cursor-envelope.json"),
  );

  it("matches the envelope shape and its own counts", () => {
    expect(envelope.count).toBe(envelope.records.length);
    expect(envelope.total_count).not.toBeNull();
    expect(envelope.next).toEqual(expect.any(String));
  });

  it("cursorPaginate consumes it: records stream out, next token drives page 2", async () => {
    const emptyPage: Paginated<CursorRecord> = {
      records: [],
      count: 0,
      total_count: envelope.total_count,
      next: null,
    };
    const cursors: (string | undefined)[] = [];
    const fetchPage = (next: string | undefined) => {
      cursors.push(next);
      return Promise.resolve(next === undefined ? envelope : emptyPage);
    };

    // `await` → first page envelope, verbatim.
    await expect(cursorPaginate(fetchPage)).resolves.toEqual(envelope);

    // `for await` → every record; the fixture's `next` token is passed back.
    cursors.length = 0;
    const items: CursorRecord[] = [];
    for await (const item of cursorPaginate(fetchPage)) items.push(item);
    expect(items).toEqual(envelope.records);
    expect(cursors).toEqual([undefined, envelope.next]);
  });
});

// ── pagination/items-envelope.json vs ConversationItemList ──────────────

const ItemListEnvelopeSchema = z.strictObject({
  object: z.literal("list"),
  data: z.array(z.record(z.string(), z.unknown())),
  first_id: z.string().nullable(),
  last_id: z.string().nullable(),
  has_more: z.boolean(),
});

const NullableString = z.string().nullable().optional();
const NullableInt = z.number().int().nullable().optional();

/**
 * The SDK `ConversationItem` interface, transliterated field-by-field.
 * Non-strict: platform-only fields are covered by the tripwire below.
 */
const ConversationItemSdkSchema = z.object({
  object: z.literal("conversation.item"),
  id: z.string(),
  type: z.literal("span"),
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: NullableString,
  created_at: IsoDate,
  span_name: z.string(),
  span_kind: z.enum([
    "UNSPECIFIED",
    "INTERNAL",
    "SERVER",
    "CLIENT",
    "PRODUCER",
    "CONSUMER",
  ]),
  node_type: z.enum(["agent", "assistant", "tool_call", "span"]),
  operation_name: NullableString,
  status_code: z.enum(["Ok", "Error", "Unset"]).nullable().optional(),
  status_message: NullableString,
  agent_name: NullableString,
  model_name: NullableString,
  request_model: NullableString,
  response_model: NullableString,
  response_id: NullableString,
  service_name: NullableString,
  provider_name: NullableString,
  duration_ns: NullableInt,
  input_tokens: NullableInt,
  output_tokens: NullableInt,
  cache_read_input_tokens: NullableInt,
  cache_creation_input_tokens: NullableInt,
  tool_name: NullableString,
  tool_call_id: NullableString,
  tool_call_arguments: NullableString,
  input_messages: z.array(z.record(z.string(), z.unknown())),
  output_message: z.record(z.string(), z.unknown()).nullable().optional(),
});

/** Every field the SDK `ConversationItem` interface declares. */
const SDK_ITEM_FIELDS = [
  ...Object.keys(ConversationItemSdkSchema.shape),
  "tool_definitions",
  "introspection",
  "span_attributes",
  "events",
  "resource_attributes",
  "system_instructions",
  "gen_ai_input_messages",
  "gen_ai_output_messages",
];

describe("fixtures/pagination/items-envelope.json vs ConversationItemList", () => {
  const fixture = readJson(
    "fixtures/pagination/items-envelope.json",
  ) as ConversationItemList;

  it("matches the after/has_more envelope shape", () => {
    expect(() => ItemListEnvelopeSchema.parse(fixture)).not.toThrow();
    expect(fixture.first_id).toBe(fixture.data[0]!.id);
    expect(fixture.last_id).toBe(fixture.data[fixture.data.length - 1]!.id);
  });

  it("each item carries every SDK-declared ConversationItem field with the declared type", () => {
    for (const item of fixture.data) {
      expect(() => ConversationItemSdkSchema.parse(item)).not.toThrow();
    }
  });

  it("KNOWN MISMATCH: item fields the SDK ConversationItem does not declare", () => {
    const undeclared = Object.keys(fixture.data[0]!).filter(
      (k) => !SDK_ITEM_FIELDS.includes(k),
    );
    expect(undeclared.sort()).toEqual(["agent_id", "cost_usd"]);
  });

  it("the items paginator drives after = last_id while has_more", async () => {
    // Two-page scenario derived in memory from the fixture (the fixture file
    // itself is a single settled page with has_more=false): page 1 re-serves
    // the fixture with has_more=true, page 2 is the fixture verbatim.
    const pageOne: ConversationItemList = { ...fixture, has_more: true };
    const afters: unknown[] = [];
    const http: ResourceHttpClient = {
      request<T>(opts: { path: string; query?: Record<string, unknown> }) {
        expect(opts.path).toBe("/v1/conversations/conv-1/items");
        afters.push(opts.query?.after);
        return Promise.resolve((afters.length === 1 ? pageOne : fixture) as T);
      },
      stream() {
        return Promise.reject(new Error("not used"));
      },
    };

    const items = [];
    for await (const item of new ConversationItemsClient(http).list("conv-1")) {
      items.push(item);
    }
    // Page 1 is fetched without a cursor; page 2 with after = page 1's
    // last_id; has_more=false on page 2 stops the walk.
    expect(afters).toEqual([undefined, fixture.last_id]);
    expect(items.map((i) => i.id)).toEqual([
      fixture.data[0]!.id,
      fixture.data[0]!.id,
    ]);
  });
});

// ── errors/*.json through the error-mapping layer ────────────────────────

interface ErrorFixture {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function errorResponse(rel: string): { fixture: ErrorFixture; res: Response } {
  const fixture = readJson(rel) as ErrorFixture;
  const res = new Response(JSON.stringify(fixture.body), {
    status: fixture.status,
    headers: { "content-type": "application/json", ...fixture.headers },
  });
  return { fixture, res };
}

describe("fixtures/errors/* through toApiError", () => {
  it("not-found.404.json → NotFoundError", async () => {
    const { res } = errorResponse("fixtures/errors/not-found.404.json");
    const err = await toApiError(res);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Task not found");
  });

  it("conflict.409.json → ConflictError", async () => {
    const { res } = errorResponse("fixtures/errors/conflict.409.json");
    const err = await toApiError(res);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.message).toBe("Run is not cancellable");
  });

  it("validation.422.json → ValidationError carrying the FastAPI detail array", async () => {
    const { fixture, res } = errorResponse(
      "fixtures/errors/validation.422.json",
    );
    const err = await toApiError(res);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(422);
    expect(err.body).toEqual(fixture.body);
    const detail = (err.body as { detail: { loc: unknown[] }[] }).detail;
    expect(detail[0]!.loc).toEqual(["body", "title"]);
  });

  it("run-stream-not-ready.429.json → RateLimitError with retryAfter=60 and the readiness phase", async () => {
    const { res } = errorResponse(
      "fixtures/errors/run-stream-not-ready.429.json",
    );
    const err = await toApiError(res);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(60);
    expect((err.body as { status: string }).status).toBe("queued");
  });
});

// ── streams/run-stream.jsonl through the AG-UI stream parsers ────────────

interface StreamFixtureFrame {
  id: string;
  event: string;
  data: Record<string, unknown> & { type?: string; name?: string };
}

const streamFrames: StreamFixtureFrame[] = readText(
  "fixtures/streams/run-stream.jsonl",
)
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as StreamFixtureFrame);

/** Re-encode fixture frames as the SSE wire bytes the DP emits. */
function toSse(frames: StreamFixtureFrame[]): string {
  return frames
    .map(
      (f) =>
        `id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`,
    )
    .join("");
}

function sseResponse(text: string, opts?: { sever?: boolean }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
    },
    // `pull` fires once the consumer has drained the queued chunk, so a
    // severed stream delivers its frames BEFORE the transport error.
    pull(controller) {
      if (opts?.sever) controller.error(new Error("connection severed"));
      else controller.close();
    },
  });
  return new Response(stream);
}

describe("fixtures/streams/run-stream.jsonl through the AG-UI parsers", () => {
  const agUiFrames = streamFrames.filter((f) => f.event === "ag_ui");

  it("every ag_ui frame passes the SDK's AG-UI event validation (EventSchemas via parseAgUiEvents)", async () => {
    // parseAgUiEvents runs each ag_ui payload through @ag-ui/core's
    // EventSchemas.parse and throws on an invalid frame — completing without
    // throwing IS the schema check. Transport frames (heartbeat) are dropped.
    const events: AGUIEvent[] = [];
    for await (const ev of parseAgUiEvents(sseResponse(toSse(streamFrames)))) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(
      agUiFrames.map((f) => f.data.type),
    );
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.CUSTOM,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ]);
  });

  it("the CUSTOM frame is a resume_gap marker with the shape resumable.ts documents", async () => {
    for await (const ev of parseAgUiEvents(sseResponse(toSse(streamFrames)))) {
      if (ev.type !== EventType.CUSTOM) continue;
      // The DP's resume-gap marker rides the AG-UI CUSTOM channel — the same
      // channel resumable.ts uses for its own introspection.reconnect marker.
      expect(ev.name).toBe("resume_gap");
      expect(ev.value).toEqual({ since: 41, buffered_from: 57 });
      return;
    }
    expect.unreachable("stream fixture must contain a CUSTOM frame");
  });

  it("control-frame ids (c-*) are ignored for resume; Last-Event-ID resumes from the last numeric id", async () => {
    // Sever the stream after the heartbeat control frame c-2 (index 5). The
    // last frames before the cut are: ...58, 59, c-2 — so a correct resume
    // cursor is "59" (the last CONTENT frame id), NOT "c-2" and NOT the c-0
    // control id from the head of the stream.
    const severed = streamFrames.slice(0, 6);
    const remainder = streamFrames.slice(6);
    const attachHeaders: (Record<string, string> | undefined)[] = [];
    const http: ResourceHttpClient = {
      request() {
        return Promise.reject(new Error("not used"));
      },
      stream(opts: { headers?: Record<string, string> }) {
        attachHeaders.push(opts.headers);
        return Promise.resolve(
          attachHeaders.length === 1
            ? sseResponse(toSse(severed), { sever: true })
            : sseResponse(toSse(remainder)),
        );
      },
    };

    const events: AGUIEvent[] = [];
    for await (const ev of streamResumable(http, "task-1", "run-1", {
      backoffMs: 1,
    })) {
      events.push(ev);
    }

    expect(attachHeaders).toHaveLength(2);
    expect(attachHeaders[0]).toBeUndefined();
    expect(attachHeaders[1]).toEqual({ "Last-Event-ID": "59" });
    // The joined sequence is gap-free: every ag_ui frame in the fixture.
    expect(events.map((e) => e.type)).toEqual(
      agUiFrames.map((f) => f.data.type),
    );
  });
});
