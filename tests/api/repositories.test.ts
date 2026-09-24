// Mocked fetch: Introspection REST wire contract only, no LLM call to record.
import { describe, expect, it, vi } from "vitest";
import {
  IntrospectionClient,
  ValidationError,
  type Repository,
  type RepositoryDirectory,
  type RepositoryFile,
} from "@introspection-sdk/introspection-node";

const CP = "https://cp.test";
const DP = "https://dp.test";
const REPO_ID = "018f6b66-4d3a-7abc-8def-0123456789ab";

const REPOSITORY: Repository = {
  id: REPO_ID,
  project_id: "018f6b66-0000-7abc-8def-0123456789ab",
  integration_id: null,
  url: "https://git.example/acme/agent.git",
  name: "agent",
  slug: "acme/agent",
  provider: "github",
  default_branch: "main",
  provisioning_status: "ready",
  seed_template: null,
  created_at: "2026-09-01T00:00:00Z",
  pushed_at: null,
  head_commit_sha: "abc123",
  is_recipe_source: true,
};

function dir(
  path: string,
  names: string[],
  next: string | null,
): RepositoryDirectory {
  return {
    type: "dir",
    path,
    commit_sha: "abc123",
    records: names.map((name) => ({
      name,
      path: path ? `${path}/${name}` : name,
      type: "file",
      size: 1,
      sha: `sha-${name}`,
    })),
    count: names.length,
    next,
  };
}

const FILE: RepositoryFile = {
  type: "file",
  name: "README.md",
  path: "README.md",
  size: 5,
  sha: "sha-readme",
  commit_sha: "abc123",
  encoding: "utf-8",
  content: "hello",
  truncated: false,
};

function client(responses: unknown[]) {
  const queue = [...responses];
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL) =>
    Response.json(queue.shift(), { status: 200 }),
  );
  const c = new IntrospectionClient({
    token: "t",
    advanced: {
      baseApiUrl: CP,
      dpUrl: DP,
      fetch: fetchImpl as unknown as typeof fetch,
    },
  });
  const urls = () =>
    fetchImpl.mock.calls.map((call) => new URL(String(call[0])));
  return { c, urls };
}

describe("RepositoriesApi", () => {
  it("list() reads the bare array from the control plane", async () => {
    const { c, urls } = client([[REPOSITORY]]);

    const repos = await c.repositories.list({
      project: "demo",
      slug: "acme/agent",
    });

    expect(repos).toEqual([REPOSITORY]);
    const [url] = urls();
    expect(url!.origin).toBe(CP);
    expect(url!.pathname).toBe("/v1/repositories");
    expect(url!.searchParams.get("project")).toBe("demo");
    expect(url!.searchParams.get("slug")).toBe("acme/agent");
  });

  it("get() reads one repository scoped to a project", async () => {
    const { c, urls } = client([REPOSITORY]);

    await expect(
      c.repositories.get(REPO_ID, { project: "demo" }),
    ).resolves.toEqual(REPOSITORY);
    expect(urls()[0]!.pathname).toBe(`/v1/repositories/${REPO_ID}`);
    expect(urls()[0]!.searchParams.get("project")).toBe("demo");
  });

  it("contents() follows the cursor across pages on the data plane", async () => {
    const { c, urls } = client([
      dir("src", ["a.ts", "b.ts"], "cursor-2"),
      dir("src", ["c.ts"], null),
    ]);

    const names: string[] = [];
    for await (const entry of c.repositories.contents(REPO_ID, {
      path: "src",
      ref: "main",
      limit: 2,
    })) {
      names.push(entry.name);
    }

    expect(names).toEqual(["a.ts", "b.ts", "c.ts"]);
    const [first, second] = urls();
    expect(first!.origin).toBe(DP);
    expect(first!.pathname).toBe(`/v1/repositories/${REPO_ID}/contents/src`);
    expect(first!.searchParams.get("ref")).toBe("main");
    expect(first!.searchParams.get("limit")).toBe("2");
    expect(first!.searchParams.has("cursor")).toBe(false);
    expect(second!.searchParams.get("cursor")).toBe("cursor-2");
    expect(second!.searchParams.get("ref")).toBe("main");
  });

  it("contents() defaults to the repository root", async () => {
    const { c, urls } = client([dir("", ["README.md"], null)]);

    const page = await c.repositories.contents(REPO_ID);

    expect(page.records[0]!.name).toBe("README.md");
    expect(urls()[0]!.pathname).toBe(`/v1/repositories/${REPO_ID}/contents`);
  });

  it("contents() throws when the path is a file", async () => {
    const { c } = client([FILE]);

    const iterate = async () => {
      for await (const entry of c.repositories.contents(REPO_ID, {
        path: "README.md",
      }))
        void entry;
    };

    await expect(iterate()).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client([FILE]).c.repositories.contents(REPO_ID, { path: "README.md" }),
    ).rejects.toThrow(/is a file/);
  });

  it("contents.get() returns a utf-8 file", async () => {
    const { c, urls } = client([FILE]);

    const content = await c.repositories.contents.get(REPO_ID, "README.md", {
      ref: "v1",
    });

    expect(content.type).toBe("file");
    if (content.type === "file") {
      expect(content.encoding).toBe("utf-8");
      expect(content.content).toBe("hello");
    }
    expect(urls()[0]!.pathname).toBe(
      `/v1/repositories/${REPO_ID}/contents/README.md`,
    );
    expect(urls()[0]!.searchParams.get("ref")).toBe("v1");
  });

  it("contents.get() percent-encodes each segment and keeps slashes", async () => {
    const fetchPath = async (path: string) => {
      const { c, urls } = client([FILE]);
      await c.repositories.contents.get(REPO_ID, path);
      return urls()[0]!.pathname;
    };

    expect(await fetchPath("docs/my notes/a#b?.md")).toBe(
      `/v1/repositories/${REPO_ID}/contents/docs/my%20notes/a%23b%3F.md`,
    );
    expect(await fetchPath("/nested/deep/")).toBe(
      `/v1/repositories/${REPO_ID}/contents/nested/deep`,
    );
  });
});
