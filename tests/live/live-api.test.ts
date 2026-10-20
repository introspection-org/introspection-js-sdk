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
 * Excluded from `pnpm test`; run with `INTROSPECTION_LIVE=1 pnpm test:live`.
 * The suite authenticates as the project's service account
 * (`INTROSPECTION_CLIENT_ID`, `INTROSPECTION_CLIENT_SECRET`,
 * `INTROSPECTION_PROJECT`) against `INTROSPECTION_BASE_API_URL` (Control
 * Plane), and the Data Plane URL comes from the token response, never from
 * configuration. `INTROSPECTION_MEMBER_TOKEN` and `INTROSPECTION_CP_SESSION`
 * cover the routes whose scopes a service account cannot hold. Without
 * `INTROSPECTION_LIVE=1` every test skips; with it, a missing setting fails
 * the test rather than skipping it, so a misconfigured run cannot pass as an
 * all-skipped one.
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
  serviceAccountToken,
  ValidationError,
  type OAuthToken,
} from "@introspection-sdk/introspection-node";

type Credential = "serviceAccount" | "session" | "member";

const MAX_RECORDS = 500;

const LIVE = process.env.INTROSPECTION_LIVE === "1";

/** `name`'s value; a live run without it fails, any other run skips. */
function setting(ctx: TestContext, name: string): string {
  requireLive(ctx);
  const value = process.env[name];
  if (!value) throw new Error(`INTROSPECTION_LIVE=1 but ${name} is not set`);
  return value;
}

function requireLive(ctx: TestContext): void {
  if (!LIVE) ctx.skip("INTROSPECTION_LIVE is not 1");
}

let minted: Promise<OAuthToken> | undefined;

/** The run's one service-account token, minted on first use. */
function serviceAccount(ctx: TestContext): Promise<OAuthToken> {
  requireLive(ctx);
  const params = {
    clientId: setting(ctx, "INTROSPECTION_CLIENT_ID"),
    clientSecret: setting(ctx, "INTROSPECTION_CLIENT_SECRET"),
    project: setting(ctx, "INTROSPECTION_PROJECT"),
    baseApiUrl: setting(ctx, "INTROSPECTION_BASE_API_URL"),
  };
  minted ??= serviceAccountToken(params);
  return minted;
}

/** The Data Plane URL the token endpoint hands the service account. */
async function discoveredDpUrl(ctx: TestContext): Promise<string> {
  const { dp_url } = await serviceAccount(ctx);
  expect(dp_url, "the token response names the Data Plane").toBeTruthy();
  return dp_url as string;
}

/**
 * The run's client for `credential`. It skips when the run is not live and
 * fails when a setting it needs is missing.
 *
 * - `serviceAccount`: the project's service account, the SDK's primary
 *   credential, built by `fromServiceAccount` so the Data Plane URL is
 *   discovered.
 * - `member`: a member's Data Plane token, for annotation tags
 *   (`annotations:write` is not a service-account scope).
 * - `session`: a member's Control Plane session, for members reads
 *   (`members:read` is not a service-account scope either). The session is
 *   sent as the cookie alone; the Control Plane refuses it beside a bearer.
 */
async function liveClient(
  ctx: TestContext,
  credential: Credential,
): Promise<IntrospectionClient> {
  requireLive(ctx);
  const baseApiUrl = setting(ctx, "INTROSPECTION_BASE_API_URL");
  if (credential === "serviceAccount") {
    return IntrospectionClient.fromServiceAccount({
      clientId: setting(ctx, "INTROSPECTION_CLIENT_ID"),
      clientSecret: setting(ctx, "INTROSPECTION_CLIENT_SECRET"),
      project: setting(ctx, "INTROSPECTION_PROJECT"),
      baseApiUrl,
    });
  }
  const token = setting(ctx, "INTROSPECTION_MEMBER_TOKEN");
  const cpSession =
    credential === "session"
      ? setting(ctx, "INTROSPECTION_CP_SESSION")
      : undefined;
  return new IntrospectionClient({
    token,
    cpSession,
    advanced: { baseApiUrl, dpUrl: await discoveredDpUrl(ctx) },
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
    const client = await liveClient(ctx, "serviceAccount");
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
    const client = await liveClient(ctx, "serviceAccount");
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
      await shares.delete(share.id);
      await expectStatus(shares.get(share.id), NotFoundError, 404);
    } finally {
      await files.delete(fileId);
    }
  });

  it("tags CRUD walk", async (ctx) => {
    // Access tags are the service account's; annotation tags need
    // `annotations:write`, which only a member holds.
    const access = (await liveClient(ctx, "serviceAccount")).tags;
    const annotations = (await liveClient(ctx, "member")).tags;
    const accessName = unique("access");
    const annotation = unique("label");

    await access.create({ kind: "access", name: accessName });
    const created = await annotations.create({
      kind: "annotation",
      name: annotation,
      color: "#f97316",
    });
    try {
      await access.get("access", accessName);
      await annotations.get("annotation", created.name);
      const listed = await collect(annotations.list("annotation"));
      expect(listed.some((tag) => tag.name === created.name)).toBe(true);

      await annotations.update("annotation", created.name, {
        color: "#22c55e",
        description: "recolored",
      });
    } finally {
      await annotations.delete("annotation", created.name);
      await access.delete("access", accessName);
    }
    await expectStatus(
      annotations.get("annotation", created.name),
      NotFoundError,
      404,
    );
  });

  it("automations CRUD walk", async (ctx) => {
    const client = await liveClient(ctx, "serviceAccount");
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
    // Fails today: the DP reads automations with deleted ones included and
    // returns no deleted_at, so a deleted automation reads back as live.
    await expectStatus(automations.get(created.id), NotFoundError, 404);
  });

  it("control-plane reads", async (ctx) => {
    const client = await liveClient(ctx, "serviceAccount");
    const project = setting(ctx, "INTROSPECTION_PROJECT");
    await collect(client.runtimes.list({ project }));
    await collect(client.recipes.list({ project }));
    await collect(client.experiments.list({ project }));
    await collect(client.connectors.list());
    await expectStatus(client.recipes.get(randomUUID()), NotFoundError, 404);
  });

  it("telemetry reads", async (ctx) => {
    const client = await liveClient(ctx, "serviceAccount");
    await client.conversations.list();
    await client.events.list({ event_name: "introspection.annotation" });
  });

  it("members reads with a Control Plane session", async (ctx) => {
    const client = await liveClient(ctx, "session");
    const members = await collect(client.members.list());
    const first = members[0];
    expect(first, "the seeded org has members").toBeDefined();
    await client.members.get(first.id);
  });

  it("rejected credentials are typed", async (ctx) => {
    requireLive(ctx);
    await expectStatus(
      serviceAccountToken({
        clientId: setting(ctx, "INTROSPECTION_CLIENT_ID"),
        clientSecret: "intro_sk_not_a_real_secret",
        project: setting(ctx, "INTROSPECTION_PROJECT"),
        baseApiUrl: setting(ctx, "INTROSPECTION_BASE_API_URL"),
      }),
      AuthenticationError,
      401,
    );

    const client = new IntrospectionClient({
      token: "not_a_real_token",
      advanced: {
        baseApiUrl: setting(ctx, "INTROSPECTION_BASE_API_URL"),
        dpUrl: await discoveredDpUrl(ctx),
      },
    });
    await expectStatus(
      client.files.get(randomUUID()),
      AuthenticationError,
      401,
    );
  });
});
