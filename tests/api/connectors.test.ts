import { describe, expect, it, vi } from "vitest";
import {
  ConnectorsApi,
  ConnectionsApi,
  HttpClient,
  attachConnectors,
} from "@introspection-sdk/introspection-node";

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
  } as unknown as HttpClient;
}

const CONNECTOR_ID = "11111111-1111-1111-1111-111111111111";
const CONNECTION_ID = "22222222-2222-2222-2222-222222222222";

const CONNECTOR_FIXTURE = {
  id: CONNECTOR_ID,
  org_id: "org-1",
  project_id: "proj-1",
  created_at: "2026-08-08T00:00:00Z",
  updated_at: "2026-08-08T00:00:00Z",
  slug: "slack-support",
  name: "Slack (support)",
  provider: "slack",
  auth_mode: "oauth_stored" as const,
  environment: "production" as const,
  scopes: ["chat:write"],
  api_hosts: ["slack.com"],
  approval_policy: "human" as const,
  status: "active" as const,
  requires_runtime: true,
};

const CONNECTION_FIXTURE = {
  id: CONNECTION_ID,
  org_id: "org-1",
  created_at: "2026-08-08T00:00:00Z",
  updated_at: "2026-08-08T00:00:00Z",
  connector_id: CONNECTOR_ID,
  member_id: "member-1",
  runtime_group_id: "rg-1",
  subject_type: "workspace" as const,
  scopes_granted: ["chat:write"],
  status: "active" as const,
  token_expires_at: null,
};

function page(records: unknown[], next: string | null = null) {
  return { records, count: records.length, total_count: records.length, next };
}

describe("ConnectorsApi", () => {
  it("list() calls GET /v1/connectors and streams records", async () => {
    const http = mockHttp({ requestResult: page([CONNECTOR_FIXTURE]) });
    const api = new ConnectorsApi(http);

    const first = await api.list({ project: "proj-1", limit: 10 });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/connectors",
      query: { project: "proj-1", limit: 10, next: undefined },
    });
    expect(first.records[0].slug).toBe("slack-support");
    expect(first.records[0].requires_runtime).toBe(true);
  });

  it("list() passes the caller's starting cursor through", async () => {
    const http = mockHttp({ requestResult: page([CONNECTOR_FIXTURE]) });
    await new ConnectorsApi(http).list({ next: "cursor-2" });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/connectors",
      query: { next: "cursor-2" },
    });
  });

  it("create() POSTs the body and carries project on the query", async () => {
    const http = mockHttp({ requestResult: CONNECTOR_FIXTURE });
    const api = new ConnectorsApi(http);

    await api.create(
      {
        name: "Slack (support)",
        provider: "slack",
        auth_mode: "oauth_stored",
        scopes: ["chat:write"],
        client_id: "client-abc",
        client_secret: "secret-xyz",
      },
      { project: "proj-1" },
    );

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/connectors",
      query: { project: "proj-1" },
      body: {
        name: "Slack (support)",
        provider: "slack",
        auth_mode: "oauth_stored",
        scopes: ["chat:write"],
        client_id: "client-abc",
        client_secret: "secret-xyz",
      },
    });
  });

  it("omits the project query entirely when none is given", async () => {
    const http = mockHttp({ requestResult: CONNECTOR_FIXTURE });
    await new ConnectorsApi(http).get(CONNECTOR_ID);

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: `/v1/connectors/${CONNECTOR_ID}`,
      query: undefined,
    });
  });

  it("update() PATCHes only the fields it is given", async () => {
    const http = mockHttp({ requestResult: CONNECTOR_FIXTURE });
    await new ConnectorsApi(http).update(
      CONNECTOR_ID,
      { name: "Slack (renamed)" },
      { project: "proj-1" },
    );

    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: `/v1/connectors/${CONNECTOR_ID}`,
      query: { project: "proj-1" },
      body: { name: "Slack (renamed)" },
    });
  });

  it("delete() expects an empty body", async () => {
    const http = mockHttp();
    await new ConnectorsApi(http).delete(CONNECTOR_ID, { project: "proj-1" });

    expect(http.request).toHaveBeenCalledWith({
      method: "DELETE",
      path: `/v1/connectors/${CONNECTOR_ID}`,
      query: { project: "proj-1" },
      expect: "empty",
    });
  });

  it("authorize() POSTs to the oauth route with connector_id merged in", async () => {
    const http = mockHttp({
      requestResult: {
        authorize_url: "https://slack.com/oauth/v2/authorize?state=abc",
        expires_in: 3600,
        expires_at: "2026-08-08T21:00:00Z",
      },
    });
    const api = new ConnectorsApi(http);

    const minted = await api.authorize(CONNECTOR_ID, {
      runtime: "support-agent",
      expires_in: 3600,
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/oauth/connections/authorize",
      body: {
        connector_id: CONNECTOR_ID,
        runtime: "support-agent",
        expires_in: 3600,
      },
    });
    expect(minted.authorize_url).toContain("slack.com");
    expect(minted.expires_in).toBe(3600);
    expect(minted.expires_at).toBe("2026-08-08T21:00:00Z");
    // `state` is the capability and travels only inside authorize_url.
    expect(minted).not.toHaveProperty("state");
  });

  it("authorize() sends only connector_id when no options are given", async () => {
    const http = mockHttp({
      requestResult: {
        authorize_url: "https://accounts.google.com/o/oauth2/v2/auth?state=x",
        expires_in: 600,
        expires_at: "2026-08-08T20:10:00Z",
      },
    });
    await new ConnectorsApi(http).authorize(CONNECTOR_ID);

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/oauth/connections/authorize",
      body: { connector_id: CONNECTOR_ID },
    });
  });

  it("attachConnectors() builds an api with connections nested", () => {
    const api = attachConnectors(mockHttp());
    expect(api).toBeInstanceOf(ConnectorsApi);
    expect(api.connections).toBeInstanceOf(ConnectionsApi);
  });
});

describe("ConnectionsApi", () => {
  it("list() targets the nested connections path", async () => {
    const http = mockHttp({ requestResult: page([CONNECTION_FIXTURE]) });
    const first = await new ConnectionsApi(http).list(CONNECTOR_ID, {
      limit: 50,
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: `/v1/connectors/${CONNECTOR_ID}/connections`,
      query: { limit: 50, next: undefined },
    });
    expect(first.records[0].subject_type).toBe("workspace");
  });

  it("create() registers an already-obtained token", async () => {
    const http = mockHttp({ requestResult: CONNECTION_FIXTURE });
    await new ConnectionsApi(http).create(CONNECTOR_ID, {
      access_token: "xoxb-token",
      subject_type: "app",
      scopes_granted: ["chat:write"],
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: `/v1/connectors/${CONNECTOR_ID}/connections`,
      body: {
        access_token: "xoxb-token",
        subject_type: "app",
        scopes_granted: ["chat:write"],
      },
    });
  });

  it("get() reads one connection under its connector", async () => {
    const http = mockHttp({ requestResult: CONNECTION_FIXTURE });
    await new ConnectionsApi(http).get(CONNECTOR_ID, CONNECTION_ID);

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: `/v1/connectors/${CONNECTOR_ID}/connections/${CONNECTION_ID}`,
    });
  });

  it("revoke() deletes the nested connection and expects no body", async () => {
    const http = mockHttp();
    await new ConnectionsApi(http).revoke(CONNECTOR_ID, CONNECTION_ID);

    expect(http.request).toHaveBeenCalledWith({
      method: "DELETE",
      path: `/v1/connectors/${CONNECTOR_ID}/connections/${CONNECTION_ID}`,
      expect: "empty",
    });
  });

  it("encodes ids that are not bare uuids", async () => {
    const http = mockHttp();
    await new ConnectionsApi(http).revoke("con/1", "cx 2");

    expect(http.request).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/v1/connectors/con%2F1/connections/cx%202",
      expect: "empty",
    });
  });
});
