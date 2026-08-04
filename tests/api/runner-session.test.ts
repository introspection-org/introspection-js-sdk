/**
 * Runner session lifecycle — `browserSession()` bootstrap serialization and
 * the `refresh()` transport rebind.
 *
 * The rebind tests run against REAL in-process `node:http` servers (no
 * mocks): a CP server whose `/run` route hands out a different DP
 * endpoint + token on each call, plus two DP servers that record which
 * bearer reached them. The bootstrap serializer tests are pure projections
 * of a held spec — nothing crosses a network boundary (AGENTS.md §6 case
 * 1), so the client is constructed directly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IntrospectionClient,
  Runner,
  type RunnerSpec,
} from "@introspection-sdk/introspection-node";
import { RunnerExpiredError } from "@introspection-sdk/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(
  __dirname,
  "../fixtures/browser-session-bootstrap.json",
);

const RUNTIME_ID = "11111111-1111-1111-1111-111111111111";

function makeSpec(overrides: {
  endpoint: string;
  token: string;
  identity?: {
    user_id?: string | null;
    anonymous_id?: string | null;
    conversation_id?: string | null;
  };
}): RunnerSpec {
  return {
    session_id: "sess-1",
    deployment: {
      endpoint: overrides.endpoint,
      slug: "gcp01",
      region: "us-east-1",
    },
    session_token: overrides.token,
    expires_at: "2025-01-01T01:00:00Z",
    runtime_context: {
      runtime_id: RUNTIME_ID,
      runtime_group_id: "33333333-3333-3333-3333-333333333333",
      experiment_id: null,
      recipe_id: "rec-1",
      recipe: {
        repository_id: "repo-1",
        git_ref: "main",
        git_commit_sha: "abc123",
      },
      arm_label: null,
      agent_name: "agent",
      identity: {
        user_id: null,
        anonymous_id: null,
        conversation_id: null,
        ...(overrides.identity ?? {}),
      },
    },
  };
}

// ── Real servers for the refresh-rebind tests ──────────────────────────

let cpServer: Server;
let dpServerA: Server;
let dpServerB: Server;
let cpUrl: string;
let dpUrlA: string;
let dpUrlB: string;
/** Bearer values seen by each DP server's `/v1/tasks`. */
const dpAuths: { a: string[]; b: string[] } = { a: [], b: [] };
let runCalls = 0;

function jsonServer(
  handler: (path: string, auth: string | undefined) => unknown,
) {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const payload = handler(url.pathname, req.headers.authorization);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

beforeAll(async () => {
  const page = {
    records: [{ id: "task-1" }],
    count: 1,
    total_count: 1,
    next: null,
  };
  dpServerA = jsonServer((path, auth) => {
    if (path === "/v1/tasks") dpAuths.a.push(auth ?? "");
    return page;
  });
  dpServerB = jsonServer((path, auth) => {
    if (path === "/v1/tasks") dpAuths.b.push(auth ?? "");
    return page;
  });
  dpUrlA = await listen(dpServerA);
  dpUrlB = await listen(dpServerB);
  cpServer = jsonServer((path) => {
    if (path === `/v1/runtimes/${RUNTIME_ID}/run`) {
      runCalls += 1;
      // First run binds DP A; every refresh re-mints against DP B.
      return runCalls === 1
        ? makeSpec({ endpoint: dpUrlA, token: "dp-token-1" })
        : makeSpec({ endpoint: dpUrlB, token: "dp-token-2" });
    }
    if (path === "/v1/runtimes") {
      return {
        records: [
          {
            id: RUNTIME_ID,
            org_id: "org-1",
            project_id: "proj-1",
            name: "Customer Agent",
            slug: "customer-agent",
            recipe_id: "rec-1",
            is_active: true,
            created_at: "2025-01-01T00:00:00Z",
            updated_at: "2025-01-01T00:00:00Z",
          },
        ],
        count: 1,
        total_count: 1,
        next: null,
      };
    }
    return {};
  });
  cpUrl = await listen(cpServer);
});

afterAll(async () => {
  for (const s of [cpServer, dpServerA, dpServerB]) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

function makeRunnerClient() {
  return new IntrospectionClient({
    token: "cp-token",
    advanced: { baseApiUrl: cpUrl },
  });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe("Runner.browserSession()", () => {
  function makeRunner(spec: RunnerSpec): Runner {
    return new Runner(
      makeRunnerClient(),
      { kind: "runtime", id: RUNTIME_ID },
      spec,
    );
  }

  it("serializes exactly the golden bootstrap fixture bytes", () => {
    const runner = makeRunner(
      makeSpec({
        endpoint: "https://dp.example.com",
        token: "runner-jwt",
        identity: { user_id: "u_42" },
      }),
    );
    const serialized = JSON.stringify(runner.browserSession(), null, 2) + "\n";
    expect(serialized).toBe(readFileSync(FIXTURE_PATH, "utf8"));
  });

  it("projects only the contract fields — no RunnerContext leakage", () => {
    const runner = makeRunner(
      makeSpec({ endpoint: "https://dp.example.com", token: "runner-jwt" }),
    );
    const bootstrap = runner.browserSession();
    expect(Object.keys(bootstrap)).toEqual([
      "session_id",
      "session_token",
      "deployment",
      "expires_at",
      "runtime_context",
    ]);
    expect(Object.keys(bootstrap.deployment)).toEqual(["endpoint"]);
    expect(Object.keys(bootstrap.runtime_context)).toEqual([
      "runtime_id",
      "identity",
    ]);
    expect(Object.keys(bootstrap.runtime_context.identity)).toEqual([
      "user_id",
      "anonymous_id",
      "conversation_id",
    ]);
  });

  it("normalizes absent identity fields to null", () => {
    const spec = makeSpec({ endpoint: "https://dp.example.com", token: "t" });
    // Servers may omit identity fields entirely; the projection pins nulls.
    spec.runtime_context.identity =
      {} as RunnerSpec["runtime_context"]["identity"];
    const runner = makeRunner(spec);
    expect(runner.browserSession().runtime_context.identity).toEqual({
      user_id: null,
      anonymous_id: null,
      conversation_id: null,
    });
  });

  it("throws once the runner is closed", async () => {
    const runner = makeRunner(
      makeSpec({ endpoint: "https://dp.example.com", token: "t" }),
    );
    await runner.close();
    expect(() => runner.browserSession()).toThrow(RunnerExpiredError);
  });
});

describe("Runner.refresh()", () => {
  it("rebinds the transport and resource clients to the fresh spec", async () => {
    const client = makeRunnerClient();
    const runner = await client.runtimes.runById(RUNTIME_ID);

    expect(runner.dpEndpoint).toBe(dpUrlA);
    await collect(runner.tasks.list());
    expect(dpAuths.a).toEqual(["Bearer dp-token-1"]);
    expect(dpAuths.b).toEqual([]);

    const tasksBeforeRefresh = runner.tasks;
    await runner.refresh();

    // The refreshed spec is exposed AND actually used: the next call goes
    // to the new endpoint with the new bearer.
    expect(runner.dpEndpoint).toBe(dpUrlB);
    await collect(runner.tasks.list());
    expect(dpAuths.a).toEqual(["Bearer dp-token-1"]);
    expect(dpAuths.b).toEqual(["Bearer dp-token-2"]);

    // Accessors stay consistent: the namespaces are re-instantiated
    // against the fresh transport.
    expect(runner.tasks).not.toBe(tasksBeforeRefresh);

    // Close still guards the rebound clients.
    await runner.close();
    await expect(collect(runner.tasks.list())).rejects.toBeInstanceOf(
      RunnerExpiredError,
    );
  });
});
