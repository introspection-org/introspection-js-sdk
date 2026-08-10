/**
 * What the REST client puts in `User-Agent`.
 *
 * Driven against a real in-process HTTP server rather than mocks, because the
 * point is what actually goes out on the wire — including the Data-Plane hop
 * the runner makes through its own client. Asserting on a config object would
 * not have caught the equivalent bug on the OTLP streams, where the transport
 * overwrote the header after the SDK set it.
 *
 * Node's default here is the bare string `node`, so before this every REST
 * call arrived unattributable to a client or a release.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { IntrospectionClient } from "@introspection-sdk/introspection-node";

const RUNTIME_ID = "11111111-1111-1111-1111-111111111111";

let server: Server;
let baseUrl: string;
let agents: (string | undefined)[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    agents.push(req.headers["user-agent"]);
    const url = new URL(req.url ?? "/", "http://localhost");
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
  agents = [];
});

describe("REST User-Agent", () => {
  it("names the SDK and its release on every hop, Data Plane included", async () => {
    const client = new IntrospectionClient({
      token: "test-token",
      advanced: { baseApiUrl: baseUrl },
    });
    const runner = await client.runtimes.runById(RUNTIME_ID);
    await runner.tasks.create({ prompt: "hello" });

    expect(agents.length).toBeGreaterThan(1);
    for (const agent of agents) {
      expect(agent).toMatch(/^introspection-sdk\/\d+\.\d+\.\d+/);
    }
  });

  it("lets the caller override it", async () => {
    const client = new IntrospectionClient({
      token: "test-token",
      advanced: {
        baseApiUrl: baseUrl,
        additionalHeaders: { "User-Agent": "my-app/1.0" },
      },
    });
    await client.runtimes.runById(RUNTIME_ID);

    expect(agents[0]).toBe("my-app/1.0");
  });
});
