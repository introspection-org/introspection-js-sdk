/**
 * INTROSPECTION_DEV_TARGET — how an app names the `introspection dev` server
 * its tasks should reach.
 *
 * Driven against a real in-process HTTP server rather than mocks, because the
 * point of these tests is what actually goes out on the wire: a header on
 * every hop, including the Data-Plane calls the runner makes through its own
 * client, and *not* a field on the `caller` payload.
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
  it("rides every request as a header, Data Plane included", async () => {
    process.env.INTROSPECTION_DEV_TARGET = "roland";

    const runner = await client().runtimes.runById(RUNTIME_ID);
    await runner.tasks.create({ prompt: "hello" });

    // The Data-Plane hop is the one that matters: a task created against a
    // dev API key has no runner claim to carry a target, and that is the path
    // this header exists for.
    expect(captured.every((c) => c.header === "roland")).toBe(true);
    expect(captured.some((c) => c.path.includes("/tasks"))).toBe(true);
  });

  it("never writes itself into the caller payload", async () => {
    process.env.INTROSPECTION_DEV_TARGET = "roland";

    await client().runtimes.runById(RUNTIME_ID, { caller: { ip: "1.2.3.4" } });

    // `caller` is descriptive metadata the app owns and the platform never
    // acts on. Injecting a routing key into it would make one key in a
    // free-form bag load-bearing, which is what this split exists to avoid.
    expect(runCall()?.body?.caller).toEqual({ ip: "1.2.3.4" });
  });

  it("is trimmed, and blank is the same as unset", async () => {
    process.env.INTROSPECTION_DEV_TARGET = "  roland  ";
    await client().runtimes.runById(RUNTIME_ID);
    expect(runCall()?.header).toBe("roland");

    captured = [];
    process.env.INTROSPECTION_DEV_TARGET = "   ";
    await client().runtimes.runById(RUNTIME_ID);
    expect(runCall()?.header).toBeUndefined();
  });

  it("changes nothing when unset", async () => {
    const runner = await client().runtimes.runById(RUNTIME_ID);
    await runner.tasks.create({ prompt: "hello" });

    expect(runCall()?.body?.caller).toBeUndefined();
    expect(captured.every((c) => c.header === undefined)).toBe(true);
  });

  it("percent-encodes a target a header cannot carry raw", async () => {
    // A header is bytes: a non-ASCII login name is not transmissible as-is,
    // and a runtime that lets it through sends latin-1 the server reads back
    // as a different string. Safe to encode because the Data Plane decodes
    // before it normalizes, so this matches the `--as andré` the CLI
    // advertises over protobuf.
    process.env.INTROSPECTION_DEV_TARGET = "andré";
    await client().runtimes.runById(RUNTIME_ID);
    expect(runCall()?.header).toBe("andr%C3%A9");

    captured = [];
    process.env.INTROSPECTION_DEV_TARGET = "roland laptop";
    await client().runtimes.runById(RUNTIME_ID);
    expect(runCall()?.header).toBe("roland%20laptop");

    // The ordinary case is untouched.
    captured = [];
    process.env.INTROSPECTION_DEV_TARGET = "roland";
    await client().runtimes.runById(RUNTIME_ID);
    expect(runCall()?.header).toBe("roland");
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
