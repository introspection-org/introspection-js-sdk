/**
 * INTROSPECTION_DEV_TARGET — how an app names the `introspection dev` server
 * its tasks should reach.
 *
 * Driven against a real in-process HTTP server rather than mocks, because the
 * point of these tests is what actually goes out on the wire: a body field on
 * the CP `/run` hop and a header on every hop, including the Data-Plane calls
 * the runner makes through its own client.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { IntrospectionClient } from "@introspection-sdk/introspection-node";

const RUNTIME_ID = "11111111-1111-1111-1111-111111111111";
const HEADER = "x-introspection-dev-target";

interface Captured {
  path: string;
  header: string | undefined;
  body: Record<string, unknown> | undefined;
}

let server: Server;
let baseUrl: string;
let captured: Captured[] = [];

function readBody(
  req: IncomingMessage,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve(undefined);
      }
    });
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    captured.push({
      path: url.pathname,
      header: req.headers[HEADER] as string | undefined,
      body: await readBody(req),
    });
    if (url.pathname.endsWith("/run")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          session_id: "sess-1",
          deployment: { endpoint: baseUrl, slug: "gcp01", region: "us-east-1" },
          session_token: "runner-jwt",
          expires_at: "2099-01-01T00:00:00Z",
          runtime_context: { runtime_id: RUNTIME_ID, identity: {} },
        }),
      );
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "task-1", status: "pending" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  captured = [];
  delete process.env.INTROSPECTION_DEV_TARGET;
});

function client(): IntrospectionClient {
  return new IntrospectionClient({
    token: "test-token",
    advanced: { baseApiUrl: baseUrl },
  });
}

const runCall = () => captured.find((c) => c.path.endsWith("/run"));

describe("INTROSPECTION_DEV_TARGET", () => {
  it("names the machine on the run body and every request header", async () => {
    process.env.INTROSPECTION_DEV_TARGET = "roland";

    const runner = await client().runtimes.runById(RUNTIME_ID);
    await runner.tasks.create({ prompt: "hello" });

    expect(runCall()?.body?.caller).toEqual({ target: "roland" });
    // The header must ride the Data-Plane hop too: a task created against a
    // dev API key has no runner claim to carry the target, and that is the
    // path this header exists for.
    expect(captured.every((c) => c.header === "roland")).toBe(true);
    expect(captured.some((c) => c.path.includes("/tasks"))).toBe(true);
  });

  it("is trimmed, and blank is the same as unset", async () => {
    process.env.INTROSPECTION_DEV_TARGET = "  roland  ";
    await client().runtimes.runById(RUNTIME_ID);
    expect(runCall()?.body?.caller).toEqual({ target: "roland" });

    captured = [];
    process.env.INTROSPECTION_DEV_TARGET = "   ";
    await client().runtimes.runById(RUNTIME_ID);
    expect(runCall()?.body?.caller).toBeUndefined();
    expect(runCall()?.header).toBeUndefined();
  });

  it("leaves an explicit caller.target alone", async () => {
    process.env.INTROSPECTION_DEV_TARGET = "roland";

    await client().runtimes.runById(RUNTIME_ID, {
      caller: { target: "julian", ip: "1.2.3.4" },
    });

    expect(runCall()?.body?.caller).toEqual({
      target: "julian",
      ip: "1.2.3.4",
    });
  });

  it("preserves the rest of an existing caller payload", async () => {
    process.env.INTROSPECTION_DEV_TARGET = "roland";

    await client().runtimes.runById(RUNTIME_ID, { caller: { ip: "1.2.3.4" } });

    expect(runCall()?.body?.caller).toEqual({
      ip: "1.2.3.4",
      target: "roland",
    });
  });

  it("changes nothing when unset", async () => {
    const runner = await client().runtimes.runById(RUNTIME_ID);
    await runner.tasks.create({ prompt: "hello" });

    expect(runCall()?.body?.caller).toBeUndefined();
    expect(captured.every((c) => c.header === undefined)).toBe(true);
  });

  it("yields to an explicitly configured header", async () => {
    process.env.INTROSPECTION_DEV_TARGET = "roland";

    const configured = new IntrospectionClient({
      token: "test-token",
      advanced: {
        baseApiUrl: baseUrl,
        additionalHeaders: { [HEADER]: "explicit" },
      },
    });
    await configured.runtimes.runById(RUNTIME_ID);

    expect(runCall()?.header).toBe("explicit");
  });
});
