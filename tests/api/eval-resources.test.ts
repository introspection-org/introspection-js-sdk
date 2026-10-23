/**
 * The Data Plane resources an eval drives: `images` and `tasks.commands`.
 * Pins the routes, the `kind`-tagged bodies, the list filters and the cap on
 * a command read's `wait_seconds`.
 *
 * A fake `fetch` stands in for the Data Plane, so no network boundary is
 * crossed (AGENTS.md §6 case 1).
 */
import { describe, expect, it } from "vitest";
import {
  DataPlaneClient,
  ImagesApi,
  MAX_COMMAND_WAIT_SECONDS,
  TaskCommandsApi,
} from "@introspection-sdk/introspection-node";
import type {
  ImageCreateParams,
  TaskCommandSpec,
} from "@introspection-sdk/introspection-node";

const DP = "https://dp.example.com";
const TASK_ID = "0199a1b2-0000-7000-8000-0000000000ee";
const IMAGE_ID = "0199a1b2-0000-7000-8000-000000000b01";
const COMMAND_ID = "0199a1b2-0000-7000-8000-000000000b02";
const FILE_ID = "0199a1b2-0000-7000-8000-000000000b03";

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

function fakeDataPlane(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    const call: Sent = {
      method: init?.method ?? "GET",
      url: String(input),
      body: typeof raw === "string" ? JSON.parse(raw) : undefined,
    };
    sent.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return {
    sent,
    dp: new DataPlaneClient({ dpUrl: DP, token: "admin-token", fetch }),
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function page(records: unknown[], next: string | null = null) {
  return { records, count: records.length, total_count: null, next };
}

describe("images", () => {
  it("is the shared ImagesApi", () => {
    const { dp } = fakeDataPlane(() => json({}));
    expect(dp.images).toBeInstanceOf(ImagesApi);
  });

  it("creates from a context archive or a pinned mirror", async () => {
    const { sent, dp } = fakeDataPlane(() =>
      json({ id: IMAGE_ID, status: "queued" }, 201),
    );
    const context: ImageCreateParams = {
      name: "hello-mcp/mcp-server",
      source: {
        kind: "context",
        file_id: FILE_ID,
        dockerfile: "docker/Dockerfile",
        platform: "linux/amd64",
      },
      provenance: { service: "mcp-server", git_sha: "abc123" },
      scan: false,
    };
    const mirror: ImageCreateParams = {
      name: "upstream/postgres",
      source: { kind: "mirror", reference: "postgres@sha256:0123" },
    };

    await dp.images.create(context);
    await dp.images.create(mirror);

    expect(sent.map((s) => [s.method, s.url, s.body])).toEqual([
      ["POST", `${DP}/v1/images`, context],
      ["POST", `${DP}/v1/images`, mirror],
    ]);
  });

  it("lists with filters, reads and deletes", async () => {
    const { sent, dp } = fakeDataPlane((call) =>
      call.method === "DELETE"
        ? new Response(null, { status: 204 })
        : call.url.includes(IMAGE_ID)
          ? json({ id: IMAGE_ID })
          : json(page([{ id: IMAGE_ID }])),
    );

    const first = await dp.images.list({
      kind: "service",
      status: "ready",
      name: "hello-mcp/mcp-server",
      limit: 5,
    });
    await dp.images.get(IMAGE_ID);
    await dp.images.delete(IMAGE_ID);

    expect(first.records).toEqual([{ id: IMAGE_ID }]);
    expect(sent.map((s) => [s.method, s.url])).toEqual([
      [
        "GET",
        `${DP}/v1/images?kind=service&status=ready&name=hello-mcp%2Fmcp-server&limit=5`,
      ],
      ["GET", `${DP}/v1/images/${IMAGE_ID}`],
      ["DELETE", `${DP}/v1/images/${IMAGE_ID}`],
    ]);
  });
});

describe("tasks.commands", () => {
  it("is the shared TaskCommandsApi", () => {
    const { dp } = fakeDataPlane(() => json({}));
    expect(dp.tasks.commands).toBeInstanceOf(TaskCommandsApi);
  });

  it("creates exec, upload and download commands tagged by kind", async () => {
    const { sent, dp } = fakeDataPlane(() =>
      json({ id: COMMAND_ID, status: "queued" }, 201),
    );
    const specs: TaskCommandSpec[] = [
      {
        kind: "exec",
        command: ["pytest", "-q"],
        cwd: "/workspace",
        timeout_seconds: 120,
        service: "db",
      },
      { kind: "upload", file_id: FILE_ID, path: "/workspace/input.json" },
      { kind: "download", path: "/workspace/report.xml" },
    ];

    for (const spec of specs) await dp.tasks.commands.create(TASK_ID, spec);

    expect(sent.map((s) => [s.method, s.url, s.body])).toEqual(
      specs.map((spec) => ["POST", `${DP}/v1/tasks/${TASK_ID}/commands`, spec]),
    );
  });

  it("lists with the status filter", async () => {
    const { sent, dp } = fakeDataPlane(() => json(page([])));
    await dp.tasks.commands.list(TASK_ID, { status: "failed", limit: 3 });

    expect(sent[0].url).toBe(
      `${DP}/v1/tasks/${TASK_ID}/commands?status=failed&limit=3`,
    );
  });

  it("caps wait_seconds at the API maximum and sends none by default", async () => {
    const { sent, dp } = fakeDataPlane(() =>
      json({ id: COMMAND_ID, status: "completed", exit_code: 0 }),
    );
    const commands = dp.tasks.commands;

    await commands.get(TASK_ID, COMMAND_ID);
    await commands.get(TASK_ID, COMMAND_ID, { wait_seconds: 10 });
    await commands.get(TASK_ID, COMMAND_ID, { wait_seconds: 3600 });
    await commands.get(TASK_ID, COMMAND_ID, { wait_seconds: -5 });

    const path = `${DP}/v1/tasks/${TASK_ID}/commands/${COMMAND_ID}`;
    expect(MAX_COMMAND_WAIT_SECONDS).toBe(60);
    expect(sent.map((s) => s.url)).toEqual([
      path,
      `${path}?wait_seconds=10`,
      `${path}?wait_seconds=${MAX_COMMAND_WAIT_SECONDS}`,
      `${path}?wait_seconds=0`,
    ]);
  });

  it("an eval task is created with kind and commands", async () => {
    const { sent, dp } = fakeDataPlane(() =>
      json({ task: { id: TASK_ID }, run: { id: "run-1", task_id: TASK_ID } }),
    );
    await dp.tasks.create({ prompt: "go", kind: "eval", commands: true });

    expect(sent[0].body).toEqual({
      prompt: "go",
      kind: "eval",
      commands: true,
    });
  });
});
