import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Polly } from "@pollyjs/core";
import FetchAdapter from "@pollyjs/adapter-fetch";
import {
  HttpClient,
  RunHandle,
  TaskRunsApi,
  RunFailedError,
  StreamIncompleteError,
} from "@introspection-sdk/introspection-node";
import { pollyEndpoints } from "../polly-setup.js";
import type { AGUIEvent } from "@introspection-sdk/types";

// Pinned SSE/status wire exchanges shared with Swift, Rust and Python.
interface Scenario {
  name: string;
  streams: string[];
  statuses: string[];
  cursors: string[];
  deltas: string[];
  error?: string;
  text_error?: string;
  statusCode?: number;
  attach_statuses?: number[];
  text?: string;
  stream_delays_ms?: number[];
  timeout_ms?: number;
}
const fixtureBytes = readFileSync(
  new URL("../fixtures/run-stream-contract.json", import.meta.url),
);
const scenarios: Scenario[] = JSON.parse(fixtureBytes.toString("utf8"));
const base = pollyEndpoints.runStream;
const taskId = "55555555-5555-5555-5555-555555555555";
const path = `/v1/tasks/${taskId}/runs/run-1`;
const run = { id: "run-1", task_id: taskId, status: "running" as const };
let polly: Polly;
let scenario: Scenario;
let cursors: string[];
let reads: number;

beforeAll(() => {
  Polly.register(FetchAdapter);
  polly = new Polly("run-stream-contract", {
    adapters: ["fetch"],
    mode: "passthrough",
  });
  polly.server
    .get(base + path + "/stream")
    .intercept(async (request, response) => {
      const index = Math.min(cursors.length, scenario.streams.length - 1);
      const body = scenario.streams[index];
      await delay(scenario.stream_delays_ms?.[index] ?? 0);
      cursors.push(String(request.headers["last-event-id"] ?? "missing"));
      response
        .status(scenario.attach_statuses?.[index] ?? scenario.statusCode ?? 200)
        .setHeader("content-type", "text/event-stream")
        .send(body);
    });
  polly.server.get(base + path).intercept((_request, response) => {
    response.status(200).json({ ...run, status: scenario.statuses[reads++] });
  });
});
afterAll(async () => {
  await polly.stop();
});

function setup(value: Scenario): TaskRunsApi {
  scenario = value;
  cursors = [];
  reads = 0;
  return new TaskRunsApi(
    new HttpClient({ apiUrl: base, token: "fixture", maxRetries: 0 }),
  );
}

describe("shared run stream contract", () => {
  it("pins the shared fixture hash", () => {
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
      "b25a2d3d463ce20ccc6e95abeccf549ef053db059c1c79a4b602f014362fc7fb",
    );
  });
  it("does not retry malformed events", async () => {
    const api = setup({
      name: "malformed",
      streams: ["id: 1\nevent: ag_ui\ndata: not-json\n\n"],
      statuses: [],
      cursors: [],
      deltas: [],
    });
    await expect(async () => {
      for await (const event of api.stream(taskId, "run-1", { backoffMs: 1 }))
        void event;
    }).rejects.toBeInstanceOf(SyntaxError);
    expect(cursors).toEqual(["0"]);
    expect(reads).toBe(0);
  });

  it("does not retry rejected credentials", async () => {
    const api = setup({
      name: "forbidden",
      streams: ["{}"],
      statuses: [],
      cursors: [],
      deltas: [],
      statusCode: 403,
    });
    await expect(async () => {
      for await (const event of api.stream(taskId, "run-1", { backoffMs: 1 }))
        void event;
    }).rejects.toMatchObject({ status: 403 });
    expect(cursors).toEqual(["0"]);
  });

  it.each(scenarios)("$name", async (value) => {
    const api = setup(value);
    const events: AGUIEvent[] = [];
    let failure: unknown;
    try {
      for await (const event of api.stream(taskId, "run-1", {
        maxReconnects: 2,
        backoffMs: 1,
        timeoutMs: value.timeout_ms,
      }))
        events.push(event);
    } catch (error) {
      failure = error;
    }
    expect(
      events.flatMap((e) =>
        "delta" in e && typeof e.delta === "string" ? [e.delta] : [],
      ),
    ).toEqual(value.deltas);
    if (value.error)
      expect(failure).toBeInstanceOf(
        value.error === "run_failed" ? RunFailedError : StreamIncompleteError,
      );
    else expect(failure).toBeUndefined();
    expect(cursors).toEqual(value.cursors);
    expect(reads).toBe(value.statuses.length);
    expect(
      events.some(
        (e) => e.type === "RUN_FINISHED" && e.result?.reason === "stream_close",
      ),
    ).toBe(false);
  });

  it.each(
    scenarios.filter(
      (s) => s.text_error || s.text !== undefined || s.name === "text_chunk",
    ),
  )("text: $name", async (value) => {
    const handle = new RunHandle(null, run, setup(value));
    if (value.text_error)
      await expect(handle.text()).rejects.toBeInstanceOf(
        value.text_error === "run_failed"
          ? RunFailedError
          : StreamIncompleteError,
      );
    else expect(await handle.text()).toBe(value.text ?? "chunk");
  });
});
