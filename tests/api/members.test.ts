import { describe, expect, it, vi } from "vitest";
import type { MemberCreateParams } from "@introspection-sdk/introspection-node";
import {
  HttpClient,
  IntrospectionClient,
  MembersApi,
} from "@introspection-sdk/introspection-node";

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
  } as unknown as HttpClient;
}

const MEMBER_ID = "33333333-3333-3333-3333-333333333333";

const MEMBER_FIXTURE = {
  id: MEMBER_ID,
  org_id: "org-1",
  created_at: "2026-10-04T00:00:00Z",
  updated_at: "2026-10-04T00:00:00Z",
  email: "ada@example.com",
  name: "Ada Lovelace",
  role: "member",
  member_type: "business" as const,
  is_deactivated: false,
  tags: ["team:acme"],
  metadata: { plan: "enterprise" },
};

function page(records: unknown[], next: string | null = null) {
  return { records, count: records.length, total_count: records.length, next };
}

describe("MembersApi", () => {
  it("list() flattens metadata into repeated key:value params beside tag", async () => {
    const http = mockHttp({ requestResult: page([MEMBER_FIXTURE]) });
    const first = await new MembersApi(http).list({
      member_type: "customer",
      tag: "customer:acme",
      metadata: { plan: "enterprise", ref: "a:b" },
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/members",
      query: {
        member_type: "customer",
        tag: "customer:acme",
        metadata: ["plan:enterprise", "ref:a:b"],
        next: undefined,
      },
    });
    expect(first.records[0].metadata).toEqual({ plan: "enterprise" });
    expect(first.records[0].tags).toEqual(["team:acme"]);
  });

  it("list() keeps the metadata filter on every page", async () => {
    const http = {
      request: vi
        .fn()
        .mockResolvedValueOnce(page([MEMBER_FIXTURE], "cur2"))
        .mockResolvedValueOnce(page([MEMBER_FIXTURE])),
    } as unknown as HttpClient;
    for await (const _ of new MembersApi(http).list({
      metadata: { plan: "enterprise" },
    }));

    const queries = (http.request as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].query,
    );
    expect(queries).toEqual([
      { metadata: ["plan:enterprise"], next: undefined },
      { metadata: ["plan:enterprise"], next: "cur2" },
    ]);
  });

  it("list() treats an empty metadata map as no filter", async () => {
    const http = mockHttp({ requestResult: page([]) });
    await new MembersApi(http).list({ metadata: {} });

    const query = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .query;
    expect(query).not.toHaveProperty("metadata");
  });

  it("create() POSTs tags and metadata with the invite", async () => {
    const http = mockHttp({ requestResult: MEMBER_FIXTURE });
    await new MembersApi(http).create({
      email: "ada@example.com",
      name: "Ada Lovelace",
      tags: ["team:acme"],
      metadata: { plan: "enterprise" },
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/members",
      body: {
        email: "ada@example.com",
        name: "Ada Lovelace",
        tags: ["team:acme"],
        metadata: { plan: "enterprise" },
      },
    });
  });

  it("create() POSTs policy attributes", async () => {
    const http = mockHttp({
      requestResult: { ...MEMBER_FIXTURE, policy_attributes: { level: 6 } },
    });
    const member = await new MembersApi(http).create({
      email: "ada@example.com",
      name: "Ada Lovelace",
      policy_attributes: { level: 6 },
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/members",
      body: {
        email: "ada@example.com",
        name: "Ada Lovelace",
        policy_attributes: { level: 6 },
      },
    });
    expect(member.policy_attributes).toEqual({ level: 6 });
  });

  it("update() PATCHes policy attributes", async () => {
    const http = mockHttp({
      requestResult: {
        ...MEMBER_FIXTURE,
        policy_attributes: { level: 7, region: "emea" },
      },
    });
    const member = await new MembersApi(http).update(MEMBER_ID, {
      policy_attributes: { level: 7, region: "emea" },
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: `/v1/members/${MEMBER_ID}`,
      body: { policy_attributes: { level: 7, region: "emea" } },
    });
    expect(member.policy_attributes).toEqual({ level: 7, region: "emea" });
  });

  it("create() POSTs a customer member keyed by external_user_id", async () => {
    const http = mockHttp({
      requestResult: {
        ...MEMBER_FIXTURE,
        member_type: "customer",
        external_user_id: "user:abc",
      },
    });
    const member = await new MembersApi(http).create({
      member_type: "customer",
      external_user_id: "user:abc",
      policy_attributes: { level: 6 },
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/members",
      body: {
        member_type: "customer",
        external_user_id: "user:abc",
        policy_attributes: { level: 6 },
      },
    });
    expect(member.member_type).toBe("customer");
  });

  it("create() params narrow on member_type", () => {
    const business: MemberCreateParams = {
      email: "ada@example.com",
      name: "Ada Lovelace",
      role: "admin",
    };
    const customer: MemberCreateParams = {
      member_type: "customer",
      external_user_id: "anon:xyz",
    };
    // @ts-expect-error a business member needs an email
    const noEmail: MemberCreateParams = { name: "Ada Lovelace" };
    // @ts-expect-error a customer member needs an external_user_id
    const noExternalId: MemberCreateParams = { member_type: "customer" };
    const noRole: MemberCreateParams = {
      member_type: "customer",
      external_user_id: "user:abc",
      // @ts-expect-error a customer member takes no role
      role: "admin",
    };

    expect([business, customer, noEmail, noExternalId, noRole]).toHaveLength(5);
  });

  it("get() reads one member", async () => {
    const http = mockHttp({ requestResult: MEMBER_FIXTURE });
    const member = await new MembersApi(http).get(MEMBER_ID);

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: `/v1/members/${MEMBER_ID}`,
    });
    expect(member.metadata).toEqual({ plan: "enterprise" });
  });

  it("update() sends an empty metadata map to clear it", async () => {
    const http = mockHttp({
      requestResult: { ...MEMBER_FIXTURE, metadata: {} },
    });
    await new MembersApi(http).update(MEMBER_ID, { metadata: {} });

    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: `/v1/members/${MEMBER_ID}`,
      body: { metadata: {} },
    });
  });

  it("update() omits metadata it is not given", async () => {
    const http = mockHttp({ requestResult: MEMBER_FIXTURE });
    await new MembersApi(http).update(MEMBER_ID, { tags: [] });

    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: `/v1/members/${MEMBER_ID}`,
      body: { tags: [] },
    });
  });
});

describe("client.members", () => {
  it("encodes each metadata pair as its own query param on the Control Plane", async () => {
    const urls: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(page([MEMBER_FIXTURE])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new IntrospectionClient({
      token: "intro_test",
      advanced: {
        baseApiUrl: "https://cp.test",
        dpUrl: "https://dp.test",
        fetch: fetch as unknown as typeof globalThis.fetch,
      },
    });

    await client.members.list({
      tag: "customer:acme",
      metadata: { plan: "enterprise", region: "eu" },
    });

    const url = new URL(urls[0]!);
    expect(url.origin).toBe("https://cp.test");
    expect(url.pathname).toBe("/v1/members");
    expect(url.searchParams.get("tag")).toBe("customer:acme");
    expect(url.searchParams.getAll("metadata")).toEqual([
      "plan:enterprise",
      "region:eu",
    ]);
    await client.shutdown();
  });
});
