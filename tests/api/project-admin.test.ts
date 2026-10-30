/**
 * The project-administration namespaces on the Control Plane: projects,
 * apiKeys, applications (with idps / secrets / keys), credentials,
 * variables, integrations, judges and oidc. Pins each route, the
 * `?project=` selector and its encoding, and the snake_case body names.
 *
 * A fake `fetch` stands in for the Control Plane, so no network boundary is
 * crossed (AGENTS.md §6 case 1).
 */
import { describe, expect, it } from "vitest";
import {
  IntrospectionClient,
  NotFoundError,
} from "@introspection-sdk/introspection-node";

const CP = "https://api.example.com";
const KEY_ID = "0199a1b2-0000-7000-8000-000000000a01";
const APP_ID = "0199a1b2-0000-7000-8000-000000000a02";
const CHILD_ID = "0199a1b2-0000-7000-8000-000000000a03";
const ROW_ID = "0199a1b2-0000-7000-8000-000000000a04";

interface Sent {
  method: string;
  url: string;
  auth: string | null;
  cookie: string | null;
  body: unknown;
}

function fakeControlPlane(respond: (sent: Sent) => Response = () => json({})) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const call: Sent = {
      method: init?.method ?? "GET",
      url: String(input),
      auth: headers.get("authorization"),
      cookie: headers.get("cookie"),
      body: typeof raw === "string" ? JSON.parse(raw) : undefined,
    };
    sent.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function empty(): Response {
  return new Response(null, { status: 204 });
}

function page(records: unknown[], next: string | null = null) {
  return { records, count: records.length, total_count: null, next };
}

function openClient(
  fetch: typeof globalThis.fetch,
  cpSession?: string,
): IntrospectionClient {
  return new IntrospectionClient({
    token: "org-token",
    cpSession,
    advanced: { baseApiUrl: CP, dpUrl: "https://dp.example.com", fetch },
  });
}

function calls(sent: Sent[]): [string, string, unknown][] {
  return sent.map((s) => [s.method, s.url, s.body]);
}

describe("projects", () => {
  it("reads by slug or id, percent-encoding the path segment", async () => {
    const { sent, fetch } = fakeControlPlane(() => json({ id: "p" }));
    const client = openClient(fetch);

    await client.projects.get("sdk tests/α");
    await client.projects.get(ROW_ID);

    expect(sent.map((s) => s.url)).toEqual([
      `${CP}/v1/projects/sdk%20tests%2F%CE%B1`,
      `${CP}/v1/projects/${ROW_ID}`,
    ]);
  });

  it("lists with the project filter and pages on next", async () => {
    let n = 0;
    const { sent, fetch } = fakeControlPlane(() =>
      json(n++ === 0 ? page([{ id: "a" }], "cur2") : page([{ id: "b" }])),
    );
    const ids: string[] = [];
    for await (const project of openClient(fetch).projects.list({
      project: "sdk-tests",
      limit: 1,
    })) {
      ids.push(project.id);
    }

    expect(ids).toEqual(["a", "b"]);
    expect(sent.map((s) => s.url)).toEqual([
      `${CP}/v1/projects?project=sdk-tests&limit=1`,
      `${CP}/v1/projects?project=sdk-tests&limit=1&next=cur2`,
    ]);
  });

  it("creates, updates and deletes by slug or id", async () => {
    const { sent, fetch } = fakeControlPlane((call) =>
      call.method === "DELETE" ? empty() : json({ id: ROW_ID }),
    );
    const projects = openClient(fetch).projects;

    await projects.create({ name: "SDK", deployment_id: CHILD_ID });
    await projects.update("sdk-tests", { description: "walk" });
    await projects.delete(ROW_ID);

    expect(calls(sent)).toEqual([
      ["POST", `${CP}/v1/projects`, { name: "SDK", deployment_id: CHILD_ID }],
      ["PATCH", `${CP}/v1/projects/sdk-tests`, { description: "walk" }],
      ["DELETE", `${CP}/v1/projects/${ROW_ID}`, undefined],
    ]);
  });
});

describe("project peerings", () => {
  const PEERING = {
    id: ROW_ID,
    org_id: CHILD_ID,
    project_id: APP_ID,
    runtime_group_id: KEY_ID,
    granted_org_id: null,
    granted_project_id: CHILD_ID,
    granted_deployment_id: null,
    expires_at: null,
    created_by_member_id: null,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    deleted_at: null,
  };

  it("lists offered peerings, narrowed by runtime group, and pages on next", async () => {
    const { sent, fetch } = fakeControlPlane((call) =>
      json(
        call.url.includes("next=")
          ? page([])
          : page([PEERING], call.url.includes("runtime=") ? "cur2" : null),
      ),
    );
    const peerings = openClient(fetch).projects.peerings;

    const first = await peerings.list("sdk tests");
    const rows = [];
    for await (const row of peerings.list("sdk-tests", "support-bot", {
      limit: 1,
    })) {
      rows.push(row);
    }

    expect(first.records).toEqual([PEERING]);
    expect(rows).toEqual([PEERING]);
    expect(sent.map((s) => s.url)).toEqual([
      `${CP}/v1/projects/sdk%20tests/peerings`,
      `${CP}/v1/projects/sdk-tests/peerings?runtime=support-bot&limit=1`,
      `${CP}/v1/projects/sdk-tests/peerings?runtime=support-bot&limit=1&next=cur2`,
    ]);
  });

  it("lists the peerings granted to a project", async () => {
    const { sent, fetch } = fakeControlPlane(() => json(page([PEERING])));

    await openClient(fetch).projects.peerings.granted(APP_ID, { limit: 5 });

    expect(sent.map((s) => s.url)).toEqual([
      `${CP}/v1/projects/${APP_ID}/peerings?granted=true&limit=5`,
    ]);
  });

  it("reads one peering by id, and surfaces 404 as NotFoundError", async () => {
    let n = 0;
    const { sent, fetch } = fakeControlPlane(() =>
      n++ === 0 ? json(PEERING) : json({ detail: "not found" }, 404),
    );
    const peerings = openClient(fetch).projects.peerings;

    expect(await peerings.get("sdk-tests", ROW_ID)).toEqual(PEERING);
    await expect(peerings.get("sdk-tests", KEY_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(calls(sent)).toEqual([
      ["GET", `${CP}/v1/projects/sdk-tests/peerings/${ROW_ID}`, undefined],
      ["GET", `${CP}/v1/projects/sdk-tests/peerings/${KEY_ID}`, undefined],
    ]);
  });
});

describe("endpoints", () => {
  it("lists with filters, reads, renames and deletes with the project selector", async () => {
    const { sent, fetch } = fakeControlPlane((call) =>
      call.method === "DELETE"
        ? empty()
        : call.method === "GET" && !call.url.includes(ROW_ID)
          ? json(page([]))
          : json({ id: ROW_ID }),
    );
    const endpoints = openClient(fetch).endpoints;

    await endpoints.list({ project: "sdk-tests", mcp_server_id: "hello" });
    await endpoints.get(ROW_ID, "sdk-tests");
    await endpoints.update(ROW_ID, { name: "renamed" }, "sdk-tests");
    await endpoints.delete(ROW_ID, "sdk-tests");

    expect(calls(sent)).toEqual([
      [
        "GET",
        `${CP}/v1/endpoints?project=sdk-tests&mcp_server_id=hello`,
        undefined,
      ],
      ["GET", `${CP}/v1/endpoints/${ROW_ID}?project=sdk-tests`, undefined],
      [
        "PATCH",
        `${CP}/v1/endpoints/${ROW_ID}?project=sdk-tests`,
        { name: "renamed" },
      ],
      ["DELETE", `${CP}/v1/endpoints/${ROW_ID}?project=sdk-tests`, undefined],
    ]);
  });
});

describe("recipes, runtimes and repositories", () => {
  it("a recipe is pinned, described and deleted", async () => {
    const { sent, fetch } = fakeControlPlane((call) =>
      call.method === "DELETE" ? empty() : json({ id: ROW_ID }),
    );
    const recipes = openClient(fetch).recipes;

    await recipes.create({
      project: "sdk-tests",
      repository_id: CHILD_ID,
      git_ref: "main",
    });
    await recipes.update(ROW_ID, { description: "walk" });
    await recipes.delete(ROW_ID, "sdk-tests");

    expect(calls(sent)).toEqual([
      [
        "POST",
        `${CP}/v1/recipes`,
        { project: "sdk-tests", repository_id: CHILD_ID, git_ref: "main" },
      ],
      ["PATCH", `${CP}/v1/recipes/${ROW_ID}`, { description: "walk" }],
      ["DELETE", `${CP}/v1/recipes/${ROW_ID}?project=sdk-tests`, undefined],
    ]);
  });

  it("a runtime version is created, read with an include, described and deleted", async () => {
    const { sent, fetch } = fakeControlPlane((call) =>
      call.method === "DELETE" ? empty() : json({ id: ROW_ID }),
    );
    const runtimes = openClient(fetch).runtimes;

    await runtimes.create({
      project: "sdk-tests",
      name: "hello",
      slug: "hello",
      recipe_id: CHILD_ID,
    });
    await runtimes.get(ROW_ID, { include: "mcp_requirements" });
    await runtimes.update(ROW_ID, { description: "walk" }, "sdk-tests");
    await runtimes.delete(ROW_ID, "sdk-tests");

    expect(calls(sent)).toEqual([
      [
        "POST",
        `${CP}/v1/runtimes`,
        {
          project: "sdk-tests",
          name: "hello",
          slug: "hello",
          recipe_id: CHILD_ID,
        },
      ],
      [
        "GET",
        `${CP}/v1/runtimes/${ROW_ID}?include=mcp_requirements`,
        undefined,
      ],
      [
        "PATCH",
        `${CP}/v1/runtimes/${ROW_ID}?project=sdk-tests`,
        { description: "walk" },
      ],
      ["DELETE", `${CP}/v1/runtimes/${ROW_ID}?project=sdk-tests`, undefined],
    ]);
  });

  it("a repository's branches read through the Data Plane and its delete through the Control Plane", async () => {
    const { sent, fetch } = fakeControlPlane((call) =>
      call.method === "DELETE"
        ? empty()
        : json(page([{ name: "main", sha: "a".repeat(40) }])),
    );
    const repositories = openClient(fetch).repositories;

    const branches = await repositories.branches(ROW_ID, { q: "ma" });
    await repositories.delete(ROW_ID, { project: "sdk-tests" });

    expect(branches.records.map((b) => b.name)).toEqual(["main"]);
    expect(calls(sent)).toEqual([
      [
        "GET",
        `https://dp.example.com/v1/repositories/${ROW_ID}/branches?q=ma`,
        undefined,
      ],
      [
        "DELETE",
        `${CP}/v1/repositories/${ROW_ID}?project=sdk-tests`,
        undefined,
      ],
    ]);
  });

  it("a connector's delete and a connection's revoke take the project selector", async () => {
    const { sent, fetch } = fakeControlPlane(() => empty());
    const connectors = openClient(fetch).connectors;

    await connectors.connections.revoke(ROW_ID, CHILD_ID, "sdk-tests");
    await connectors.delete(ROW_ID, "sdk-tests");
    await connectors.delete(ROW_ID);

    expect(sent.map((s) => s.url)).toEqual([
      `${CP}/v1/connectors/${ROW_ID}/connections/${CHILD_ID}?project=sdk-tests`,
      `${CP}/v1/connectors/${ROW_ID}?project=sdk-tests`,
      `${CP}/v1/connectors/${ROW_ID}`,
    ]);
  });
});

describe("apiKeys", () => {
  it("unwraps the unpaginated api_keys envelope", async () => {
    const { sent, fetch } = fakeControlPlane(() =>
      json({ api_keys: [{ id: KEY_ID }] }),
    );
    const keys = await openClient(fetch).apiKeys.list({
      project: "sdk-tests",
      expiring: true,
    });

    expect(keys).toEqual([{ id: KEY_ID }]);
    expect(sent[0].url).toBe(
      `${CP}/v1/api-keys?project=sdk-tests&expiring=true`,
    );
  });

  it("creates, updates, rotates and acknowledges a key", async () => {
    const { sent, fetch } = fakeControlPlane((call) => {
      if (call.method === "DELETE") return empty();
      if (call.url.endsWith("/acknowledge?project=sdk-tests"))
        return json({ acknowledged: true });
      return json({ id: KEY_ID, api_key: "intro_sk_plaintext" });
    });
    const apiKeys = openClient(fetch).apiKeys;

    const created = await apiKeys.create(
      { name: "ci", environment: "staging", allow: ["evals"] },
      "sdk-tests",
    );
    await apiKeys.update(KEY_ID, { name: "renamed", allow: [] });
    await apiKeys.delete(KEY_ID, { project: "sdk-tests", expires_in: 3600 });
    await apiKeys.delete(KEY_ID);
    const ack = await apiKeys.acknowledge(KEY_ID, "sdk-tests");

    expect(created.api_key).toBe("intro_sk_plaintext");
    expect(ack).toEqual({ acknowledged: true });
    expect(calls(sent)).toEqual([
      [
        "POST",
        `${CP}/v1/api-keys?project=sdk-tests`,
        { name: "ci", environment: "staging", allow: ["evals"] },
      ],
      ["PATCH", `${CP}/v1/api-keys/${KEY_ID}`, { name: "renamed", allow: [] }],
      [
        "DELETE",
        `${CP}/v1/api-keys/${KEY_ID}?project=sdk-tests&expires_in=3600`,
        undefined,
      ],
      ["DELETE", `${CP}/v1/api-keys/${KEY_ID}`, undefined],
      [
        "POST",
        `${CP}/v1/api-keys/${KEY_ID}/acknowledge?project=sdk-tests`,
        undefined,
      ],
    ]);
  });

  it("sends a Control Plane session as the cookie alone", async () => {
    const { sent, fetch } = fakeControlPlane(() => json({ api_keys: [] }));
    await openClient(fetch, "sess-blob").apiKeys.list();

    expect(sent[0].cookie).toBe("intro_cp_session=sess-blob");
    expect(sent[0].auth).toBeNull();
  });
});

describe("applications", () => {
  it("CRUD carries the project selector", async () => {
    const { sent, fetch } = fakeControlPlane((call) =>
      call.method === "DELETE"
        ? empty()
        : call.method === "GET" && !call.url.includes(APP_ID)
          ? json(page([]))
          : json({ id: APP_ID }),
    );
    const applications = openClient(fetch).applications;

    await applications.list({ project: "sdk-tests", limit: 10 });
    await applications.create(
      { name: "svc", application_type: "service_account" },
      "sdk-tests",
    );
    await applications.get(APP_ID, "sdk-tests");
    await applications.update(APP_ID, { allowed_scopes: ["tasks:read"] });
    await applications.delete(APP_ID, "sdk-tests");

    expect(calls(sent)).toEqual([
      ["GET", `${CP}/v1/applications?project=sdk-tests&limit=10`, undefined],
      [
        "POST",
        `${CP}/v1/applications?project=sdk-tests`,
        { name: "svc", application_type: "service_account" },
      ],
      ["GET", `${CP}/v1/applications/${APP_ID}?project=sdk-tests`, undefined],
      [
        "PATCH",
        `${CP}/v1/applications/${APP_ID}`,
        { allowed_scopes: ["tasks:read"] },
      ],
      [
        "DELETE",
        `${CP}/v1/applications/${APP_ID}?project=sdk-tests`,
        undefined,
      ],
    ]);
  });

  it("nests idps, secrets and keys under the application", async () => {
    const { sent, fetch } = fakeControlPlane((call) => {
      if (call.method === "DELETE") return empty();
      if (call.method === "GET" && call.url.includes("/keys"))
        return json([{ id: CHILD_ID }]);
      if (call.method === "GET") return json(page([]));
      return json({ id: CHILD_ID, secret: "intro_cs_plaintext" });
    });
    const { idps, secrets, keys } = openClient(fetch).applications;
    const base = `${CP}/v1/applications/${APP_ID}`;

    await idps.list(APP_ID, { limit: 5 });
    await idps.create(APP_ID, {
      idp_provider: "auth0",
      issuer: "https://acme.auth0.com/",
      client_id: "cid",
      client_secret: "csecret",
    });
    await idps.delete(APP_ID, CHILD_ID);
    await secrets.list(APP_ID);
    const secret = await secrets.create(APP_ID, { name: "ci" });
    await secrets.delete(APP_ID, CHILD_ID, 600);
    await secrets.delete(APP_ID, CHILD_ID);
    const listedKeys = await keys.list(APP_ID);
    await keys.create(APP_ID);
    await keys.delete(APP_ID, CHILD_ID);

    expect(secret.secret).toBe("intro_cs_plaintext");
    expect(listedKeys).toEqual([{ id: CHILD_ID }]);
    expect(calls(sent)).toEqual([
      ["GET", `${base}/idps?limit=5`, undefined],
      [
        "POST",
        `${base}/idps`,
        {
          idp_provider: "auth0",
          issuer: "https://acme.auth0.com/",
          client_id: "cid",
          client_secret: "csecret",
        },
      ],
      ["DELETE", `${base}/idps/${CHILD_ID}`, undefined],
      ["GET", `${base}/secrets`, undefined],
      ["POST", `${base}/secrets`, { name: "ci" }],
      ["DELETE", `${base}/secrets/${CHILD_ID}?expires_in=600`, undefined],
      ["DELETE", `${base}/secrets/${CHILD_ID}`, undefined],
      ["GET", `${base}/keys`, undefined],
      ["POST", `${base}/keys`, undefined],
      ["DELETE", `${base}/keys/${CHILD_ID}`, undefined],
    ]);
  });
});

describe("credentials and variables", () => {
  it("credentials send the write-only secret and the list filters", async () => {
    const { sent, fetch } = fakeControlPlane((call) =>
      call.method === "DELETE"
        ? empty()
        : call.method === "GET" && !call.url.includes(ROW_ID)
          ? json(page([]))
          : json({ id: ROW_ID, has_secret: true }),
    );
    const credentials = openClient(fetch).credentials;

    await credentials.list({
      project: "sdk-tests",
      runtime: "agent",
      environment: "production",
    });
    await credentials.create(
      { name: "OPENAI_API_KEY", secret: "sk-1", environment: "staging" },
      "sdk-tests",
    );
    const read = await credentials.get(ROW_ID);
    await credentials.update(ROW_ID, { secret: "sk-2" }, "sdk-tests");
    await credentials.delete(ROW_ID);

    expect(read.has_secret).toBe(true);
    expect(calls(sent)).toEqual([
      [
        "GET",
        `${CP}/v1/credentials?project=sdk-tests&runtime=agent&environment=production`,
        undefined,
      ],
      [
        "POST",
        `${CP}/v1/credentials?project=sdk-tests`,
        { name: "OPENAI_API_KEY", secret: "sk-1", environment: "staging" },
      ],
      ["GET", `${CP}/v1/credentials/${ROW_ID}`, undefined],
      [
        "PATCH",
        `${CP}/v1/credentials/${ROW_ID}?project=sdk-tests`,
        { secret: "sk-2" },
      ],
      ["DELETE", `${CP}/v1/credentials/${ROW_ID}`, undefined],
    ]);
  });

  it("variables have no read-one route", async () => {
    const { sent, fetch } = fakeControlPlane((call) =>
      call.method === "DELETE" ? empty() : json({ id: ROW_ID }),
    );
    const variables = openClient(fetch).variables;

    expect(variables).not.toHaveProperty("get");
    await variables.create({ name: "REGION", value: "eu" }, "sdk-tests");
    await variables.update(ROW_ID, { kind: "credential", value: "TOKEN" });
    await variables.delete(ROW_ID, "sdk-tests");

    expect(calls(sent)).toEqual([
      [
        "POST",
        `${CP}/v1/variables?project=sdk-tests`,
        { name: "REGION", value: "eu" },
      ],
      [
        "PATCH",
        `${CP}/v1/variables/${ROW_ID}`,
        { kind: "credential", value: "TOKEN" },
      ],
      ["DELETE", `${CP}/v1/variables/${ROW_ID}?project=sdk-tests`, undefined],
    ]);
  });
});

describe("integrations", () => {
  it("is org-wide and sends the wire field `type`", async () => {
    const { sent, fetch } = fakeControlPlane((call) =>
      call.method === "DELETE"
        ? empty()
        : call.url.endsWith("/v1/integrations?limit=2")
          ? json(page([]))
          : json({ id: ROW_ID, type: "github", status: "pending" }),
    );
    const integrations = openClient(fetch).integrations;

    await integrations.list({ limit: 2 });
    const created = await integrations.create({ type: "github", name: "gh" });
    await integrations.get(ROW_ID);
    await integrations.update(ROW_ID, {
      external_id: "12345",
      slack_interactivity_enabled: false,
    });
    await integrations.delete(ROW_ID);

    expect(created.type).toBe("github");
    expect(calls(sent)).toEqual([
      ["GET", `${CP}/v1/integrations?limit=2`, undefined],
      ["POST", `${CP}/v1/integrations`, { type: "github", name: "gh" }],
      ["GET", `${CP}/v1/integrations/${ROW_ID}`, undefined],
      [
        "PATCH",
        `${CP}/v1/integrations/${ROW_ID}`,
        { external_id: "12345", slack_interactivity_enabled: false },
      ],
      ["DELETE", `${CP}/v1/integrations/${ROW_ID}`, undefined],
    ]);
  });
});

describe("judges", () => {
  it("reads and changes only the operational fields", async () => {
    const { sent, fetch } = fakeControlPlane((call) =>
      call.url.includes(ROW_ID) ? json({ id: ROW_ID }) : json(page([])),
    );
    const judges = openClient(fetch).judges;

    await judges.list({ project: "sdk-tests", runtime_group_id: APP_ID });
    await judges.get(ROW_ID, "sdk-tests");
    await judges.update(ROW_ID, { enabled: false, sample_rate: 0.25 });

    expect(judges).not.toHaveProperty("create");
    expect(calls(sent)).toEqual([
      [
        "GET",
        `${CP}/v1/judges?project=sdk-tests&runtime_group_id=${APP_ID}`,
        undefined,
      ],
      ["GET", `${CP}/v1/judges/${ROW_ID}?project=sdk-tests`, undefined],
      [
        "PATCH",
        `${CP}/v1/judges/${ROW_ID}`,
        { enabled: false, sample_rate: 0.25 },
      ],
    ]);
  });

  it("a missing judge is a typed 404", async () => {
    const { fetch } = fakeControlPlane(() =>
      json({ detail: "Judge not found" }, 404),
    );
    await expect(openClient(fetch).judges.get(ROW_ID)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("oidc", () => {
  it("me() reads feature flags of every value type", async () => {
    const me = {
      authenticated: true,
      org_id: "org-1",
      member_id: "member-1",
      feature_flags: { evals: true, max_runtimes: 3, tier: "pro" },
    };
    const { sent, fetch } = fakeControlPlane(() => json(me));

    expect(await openClient(fetch).oidc.me()).toEqual(me);
    expect(calls(sent)).toEqual([["GET", `${CP}/v1/oidc/me`, undefined]]);
  });
});
