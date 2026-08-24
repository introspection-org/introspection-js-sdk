import { describe, expect, it, vi } from "vitest";
import { HttpClient, DatasetsApi } from "@introspection-sdk/introspection-node";

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
    stream: vi.fn().mockResolvedValue(overrides.streamResult ?? new Response()),
  } as unknown as HttpClient;
}

const DATASET_FIXTURE = {
  id: "ds-1",
  org_id: "org-1",
  project_id: "proj-1",
  slug: "gold-conversations",
  description: "Curated gold set",
  labels: ["gold", "tone"],
  created_by_member_id: "member-1",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

describe("DatasetsApi", () => {
  it("list() calls GET /v1/datasets with filters", async () => {
    const http = mockHttp({
      requestResult: {
        records: [DATASET_FIXTURE],
        count: 1,
        total_count: null,
        next: null,
      },
    });
    const api = new DatasetsApi(http);
    const datasets = [];
    for await (const d of api.list({
      slug: "gold-conversations",
      created_by_member_id: "member-1",
      limit: 5,
    })) {
      datasets.push(d);
    }

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/datasets",
      query: {
        slug: "gold-conversations",
        created_by_member_id: "member-1",
        limit: 5,
      },
    });
    expect(datasets).toHaveLength(1);
  });

  it("list() paginates through all pages", async () => {
    const page1 = {
      records: [DATASET_FIXTURE],
      count: 1,
      total_count: null,
      next: "cur2",
    };
    const page2 = {
      records: [{ ...DATASET_FIXTURE, id: "ds-2" }],
      count: 1,
      total_count: null,
      next: null,
    };
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const api = new DatasetsApi(http);
    const datasets = [];
    for await (const d of api.list()) datasets.push(d);

    expect(datasets).toHaveLength(2);
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it("create() calls POST /v1/datasets with the body", async () => {
    const http = mockHttp({ requestResult: DATASET_FIXTURE });
    const api = new DatasetsApi(http);
    await api.create({
      slug: "gold-conversations",
      description: "Curated gold set",
      labels: ["gold", "tone"],
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/datasets",
      body: {
        slug: "gold-conversations",
        description: "Curated gold set",
        labels: ["gold", "tone"],
      },
    });
  });

  it("get() calls GET /v1/datasets/:id", async () => {
    const http = mockHttp({ requestResult: DATASET_FIXTURE });
    const api = new DatasetsApi(http);
    await api.get("ds-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/datasets/ds-1",
    });
  });

  it("update() calls PATCH /v1/datasets/:id", async () => {
    const http = mockHttp({ requestResult: DATASET_FIXTURE });
    const api = new DatasetsApi(http);
    await api.update("ds-1", { description: "Renamed set" });

    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/v1/datasets/ds-1",
      body: { description: "Renamed set" },
    });
  });

  it("update() replaces the label predicate", async () => {
    const http = mockHttp({ requestResult: DATASET_FIXTURE });
    const api = new DatasetsApi(http);
    await api.update("ds-1", { labels: ["gold"] });

    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/v1/datasets/ds-1",
      body: { labels: ["gold"] },
    });
  });

  it("delete() calls DELETE /v1/datasets/:id with empty expect", async () => {
    const http = mockHttp();
    const api = new DatasetsApi(http);
    await api.delete("ds-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/v1/datasets/ds-1",
      expect: "empty",
    });
  });

  it("URL-encodes dataset IDs", async () => {
    const http = mockHttp({ requestResult: DATASET_FIXTURE });
    const api = new DatasetsApi(http);
    await api.get("ds/special id");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/datasets/ds%2Fspecial%20id",
    });
  });
});
