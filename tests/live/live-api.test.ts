/**
 * Live CRUD walks against a real deployment: a local stack seeded by
 * `introspection-cloud`'s `scripts/seed_sdk_project.py`, or the staging
 * `sdk-tests` project.
 *
 * The unit suites pin what the SDK *sends*; these pin that a deployed API
 * *answers* it, and they are what the backend coverage run drives. Each test
 * creates what it reads and deletes it again, so it holds no state between
 * runs. Nothing here goes through Polly: these requests must reach the stack.
 *
 * Excluded from `pnpm test`; run with `INTROSPECTION_LIVE=1 pnpm test:live`,
 * reading `INTROSPECTION_TOKEN`, `INTROSPECTION_BASE_API_URL` (Control Plane),
 * `INTROSPECTION_DP_URL` (Data Plane), `INTROSPECTION_CP_SESSION` and
 * `INTROSPECTION_MEMBER_TOKEN`. A test whose settings are missing skips.
 *
 * Mirrors the Rust SDK's `tests/live_api_test.rs`.
 *
 * `test:live` sets `NODE_USE_ENV_PROXY=1` so that, behind an `HTTPS_PROXY`,
 * Node's own fetch routes the requests: the SDK's undici-based proxy fetch
 * sends a global `FormData` body without its multipart encoding, so every
 * upload fails with a 422 there.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, type TestContext } from "vitest";
import {
  AuthenticationError,
  IntrospectionClient,
  NotFoundError,
  ValidationError,
} from "@introspection-sdk/introspection-node";

type Credential = "apiKey" | "session" | "member";

const MAX_RECORDS = 500;

function setting(ctx: TestContext, name: string): string {
  const value = process.env[name];
  if (!value) ctx.skip(`${name} is not set`);
  return value as string;
}

/**
 * The run's client for `credential`, or a skip when the run is not live or a
 * setting it needs is missing.
 *
 * - `apiKey`: the project's API key, the SDK's primary credential.
 * - `session`: the API key plus a member's Control Plane session, for
 *   member-authored Control Plane routes.
 * - `member`: a member's Data Plane token, for the Data Plane writes no API
 *   key capability grants (automations, tags, share deletion).
 */
function liveClient(
  ctx: TestContext,
  credential: Credential,
): IntrospectionClient {
  if (process.env.INTROSPECTION_LIVE !== "1") {
    ctx.skip("INTROSPECTION_LIVE is not 1");
  }
  const token =
    credential === "member"
      ? setting(ctx, "INTROSPECTION_MEMBER_TOKEN")
      : setting(ctx, "INTROSPECTION_TOKEN");
  const cpSession =
    credential === "session"
      ? setting(ctx, "INTROSPECTION_CP_SESSION")
      : undefined;
  return new IntrospectionClient({
    token,
    cpSession,
    advanced: {
      baseApiUrl: process.env.INTROSPECTION_BASE_API_URL,
      dpUrl: process.env.INTROSPECTION_DP_URL,
    },
  });
}

/**
 * A name no other run shares, so concurrent runs against one project never
 * collide and a leftover from a crashed run is recognisable.
 */
function unique(prefix: string): string {
  return `sdk-${prefix}-${randomUUID().replaceAll("-", "")}`;
}

/** Every record a listing streams, bounded so a large project cannot stall a walk. */
async function collect<T>(listing: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of listing) {
    out.push(item);
    if (out.length >= MAX_RECORDS) break;
  }
  return out;
}

async function expectStatus<E extends abstract new (...args: never) => Error>(
  promise: Promise<unknown>,
  errorClass: E,
  status: number,
): Promise<void> {
  const err = await promise.then(
    (value) => {
      throw new Error(
        `expected HTTP ${status}, got ${JSON.stringify(value) ?? "a value"}`,
      );
    },
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(errorClass);
  expect((err as { status: number }).status).toBe(status);
}

describe("live API", () => {
  it("files CRUD walk", async (ctx) => {
    const client = liveClient(ctx, "apiKey");
    const files = client.files;
    const name = `${unique("file")}.txt`;

    const created = await files.createText({
      name,
      content: "hello from the js sdk",
      mime_type: "text/plain",
      metadata: { suite: "live" },
    });
    const fileId = created.id;

    const fetched = await files.get(fileId);
    expect(fetched.name).toBe(name);

    const listed = await collect(files.list({ name, include_total: true }));
    expect(listed.some((file) => file.id === fileId)).toBe(true);

    const renamed = `${unique("renamed")}.txt`;
    const updated = await files.update(fileId, {
      name: renamed,
      metadata: { suite: "live-updated" },
    });
    expect(updated.name).toBe(renamed);

    const body = await files.download(fileId);
    expect(new TextDecoder().decode(body)).toBe("hello from the js sdk");

    const version = await files.versions.create(fileId, {
      file: new TextEncoder().encode("second version"),
      name: renamed,
      contentType: "text/plain",
    });
    const versions = await collect(files.versions.list(fileId));
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.some((v) => v.id === version.id)).toBe(true);
    await files.versions.get(fileId, version.id);

    await files.delete(fileId);
    await expectStatus(files.get(fileId), NotFoundError, 404);
  });

  it("upload and shares CRUD walk", async (ctx) => {
    const client = liveClient(ctx, "apiKey");
    const files = client.files;
    const file = await files.upload({
      file: new TextEncoder().encode("shared bytes"),
      name: `${unique("shared")}.bin`,
      contentType: "application/octet-stream",
    });
    const fileId = file.id;
    const shares = client.shares;
    try {
      const share = await shares.create({
        resource_type: "file",
        resource_id: fileId,
        granted_tag: unique("audience"),
      });
      await shares.get(share.id);
      const listed = await collect(
        shares.list({ resource_type: "file", resource_id: fileId }),
      );
      expect(listed.some((s) => s.id === share.id)).toBe(true);
      // `visible_from` windows a conversation's history; a file share refuses it.
      await expectStatus(
        shares.update(share.id, { visible_from: "2026-01-01T00:00:00Z" }),
        ValidationError,
        422,
      );
      // No API key capability carries `shares:delete`, so a member removes it.
      const member = liveClient(ctx, "member");
      await member.shares.delete(share.id);
      await expectStatus(shares.get(share.id), NotFoundError, 404);
    } finally {
      await files.delete(fileId);
    }
  });

  it("tags CRUD walk", async (ctx) => {
    const client = liveClient(ctx, "member");
    const tags = client.tags;
    const access = unique("access");
    const annotation = unique("label");

    await tags.create({ kind: "access", name: access });
    const created = await tags.create({
      kind: "annotation",
      name: annotation,
      color: "#f97316",
    });
    try {
      await tags.get("access", access);
      await tags.get("annotation", created.name);
      const listed = await collect(tags.list("annotation"));
      expect(listed.some((tag) => tag.name === created.name)).toBe(true);

      await tags.update("annotation", created.name, {
        color: "#22c55e",
        description: "recolored",
      });
    } finally {
      await tags.delete("annotation", created.name);
      await tags.delete("access", access);
    }
    await expectStatus(
      tags.get("annotation", created.name),
      NotFoundError,
      404,
    );
  });

  it("automations CRUD walk", async (ctx) => {
    const client = liveClient(ctx, "member");
    // An automation dispatches into a runtime group, so it needs a runtime
    // the seed does not create.
    const runtimeGroupId = setting(ctx, "INTROSPECTION_RUNTIME_GROUP_ID");
    const automations = client.automations;

    const created = await automations.create({
      name: unique("automation"),
      trigger_type: "manual",
      description: "created by the js sdk live suite",
      prompt: "Reply with exactly: hi",
      runtime_group_id: runtimeGroupId,
      enabled: false,
    });
    try {
      await automations.get(created.id);
      const listed = await collect(automations.list());
      expect(listed.some((a) => a.id === created.id)).toBe(true);
      await automations.update(created.id, { description: "updated" });
    } finally {
      await automations.delete(created.id);
    }
    // The DP reads an automation with deleted ones included, so a deleted one
    // comes back stamped rather than 404. `Automation` does not type the field.
    const deleted = (await automations.get(created.id)) as {
      deleted_at?: string | null;
    };
    expect(deleted.deleted_at).toBeTruthy();
  });

  it("control-plane reads", async (ctx) => {
    const client = liveClient(ctx, "apiKey");
    const project = setting(ctx, "INTROSPECTION_PROJECT");
    await collect(client.runtimes.list({ project }));
    await collect(client.recipes.list({ project }));
    await collect(client.experiments.list({ project }));
    await collect(client.connectors.list());
    await expectStatus(client.recipes.get(randomUUID()), NotFoundError, 404);
  });

  it("telemetry reads", async (ctx) => {
    const client = liveClient(ctx, "apiKey");
    await client.conversations.list();
    await client.events.list({ event_name: "introspection.annotation" });
  });

  it("members reads with a Control Plane session", async (ctx) => {
    const client = liveClient(ctx, "session");
    const members = await collect(client.members.list());
    const first = members[0];
    expect(first, "the seeded org has members").toBeDefined();
    await client.members.get(first.id);
  });

  it("rejected credentials are typed", async (ctx) => {
    liveClient(ctx, "apiKey");
    const client = new IntrospectionClient({
      token: "intro_dev_not_a_real_key",
      advanced: {
        baseApiUrl: process.env.INTROSPECTION_BASE_API_URL,
        dpUrl: process.env.INTROSPECTION_DP_URL,
      },
    });
    await expectStatus(
      client.files.get(randomUUID()),
      AuthenticationError,
      401,
    );
  });
});
