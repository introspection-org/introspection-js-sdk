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
  IntrospectionAPIError,
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

/** The HTTP status `promise` rejects with; fails if it resolves. */
async function rejectionStatus(promise: Promise<unknown>): Promise<number> {
  const err = await promise.then(
    (value) => {
      throw new Error(`expected an error, got ${JSON.stringify(value)}`);
    },
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(IntrospectionAPIError);
  return (err as IntrospectionAPIError).status;
}

/** A setting name no other run shares, in the API's `[A-Z0-9_]` shape. */
function uniqueSettingName(): string {
  return `SDK_${randomUUID().replaceAll("-", "")}`.toUpperCase();
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

  // --- project administration: an org credential (the CP session) --------

  it("oidc.me with a Control Plane session", async (ctx) => {
    const client = await liveClient(ctx, "session");
    const me = await client.oidc.me();
    expect(me.authenticated).toBe(true);
    expect(me.member_id, "a member session names its member").toBeTruthy();
    expect(me.org_id).toBeTruthy();
  });

  it("projects reads", async (ctx) => {
    // Read-only: no SDK credential carries projects:write / projects:delete.
    const client = await liveClient(ctx, "session");
    const slug = setting(ctx, "INTROSPECTION_PROJECT");
    const seeded = await client.projects.get(slug);
    const listed = await collect(client.projects.list());
    expect(listed.some((p) => p.id === seeded.id)).toBe(true);
    await expectStatus(client.projects.get(randomUUID()), NotFoundError, 404);
  });

  it("api keys CRUD walk", async (ctx) => {
    const keys = (await liveClient(ctx, "session")).apiKeys;
    const project = setting(ctx, "INTROSPECTION_PROJECT");

    const created = await keys.create(
      { name: unique("key"), environment: "development" },
      project,
    );
    try {
      expect(created.api_key, "the plaintext rides the create").toBeTruthy();
      expect((await keys.acknowledge(created.id, project)).acknowledged).toBe(
        true,
      );
      await expectStatus(
        keys.acknowledge(created.id, project),
        NotFoundError,
        404,
      );
      const listed = await keys.list({ project });
      expect(listed.some((k) => k.id === created.id)).toBe(true);
      const renamed = unique("key-renamed");
      const updated = await keys.update(created.id, { name: renamed }, project);
      expect(updated.name).toBe(renamed);
    } finally {
      await keys.delete(created.id, { project });
    }
    const listed = await keys.list({ project });
    expect(
      listed.some((k) => k.id === created.id && k.status === "active"),
    ).toBe(false);
  });

  it("applications CRUD walk", async (ctx) => {
    const applications = (await liveClient(ctx, "session")).applications;
    const project = setting(ctx, "INTROSPECTION_PROJECT");

    // Every plan may create a service account; browser and federated types
    // are plan-gated.
    const created = await applications.create(
      { name: unique("app"), application_type: "service_account" },
      project,
    );
    const appId = created.id;
    try {
      await applications.get(appId, project);
      const listed = await collect(applications.list({ project }));
      expect(listed.some((a) => a.id === appId)).toBe(true);
      const renamed = unique("app-renamed");
      const updated = await applications.update(
        appId,
        { name: renamed },
        project,
      );
      expect(updated.name).toBe(renamed);

      const secret = await applications.secrets.create(appId, {
        name: unique("secret"),
      });
      expect(secret.secret, "the plaintext rides the create").toBeTruthy();
      const secrets = await collect(applications.secrets.list(appId));
      expect(secrets.some((s) => s.id === secret.id)).toBe(true);
      await applications.secrets.delete(appId, secret.id);

      const key = await applications.keys.create(appId);
      const keys = await applications.keys.list(appId);
      expect(keys.some((k) => k.id === key.id)).toBe(true);
      await applications.keys.delete(appId, key.id);

      expect(await collect(applications.idps.list(appId))).toEqual([]);
      // A service account federates no end users, so the attach is refused;
      // reaching that refusal is what pins the route and body.
      const status = await rejectionStatus(
        applications.idps.create(appId, { issuer: "https://idp.example.com" }),
      );
      expect([400, 403]).toContain(status);
    } finally {
      await applications.delete(appId, project);
    }
    await expectStatus(applications.get(appId, project), NotFoundError, 404);
  });

  it("credentials CRUD walk", async (ctx) => {
    const credentials = (await liveClient(ctx, "session")).credentials;
    const project = setting(ctx, "INTROSPECTION_PROJECT");
    const name = uniqueSettingName();

    const created = await credentials.create(
      { name, secret: "sk-live-suite" },
      project,
    );
    try {
      expect(created.has_secret).toBe(true);
      expect((await credentials.get(created.id, project)).name).toBe(name);
      const listed = await collect(credentials.list({ project }));
      expect(listed.some((c) => c.id === created.id)).toBe(true);
      await credentials.update(created.id, { secret: "sk-rotated" }, project);
    } finally {
      await credentials.delete(created.id, project);
    }
    await expectStatus(
      credentials.get(created.id, project),
      NotFoundError,
      404,
    );
  });

  it("variables CRUD walk", async (ctx) => {
    const variables = (await liveClient(ctx, "session")).variables;
    const project = setting(ctx, "INTROSPECTION_PROJECT");

    const created = await variables.create(
      { name: uniqueSettingName(), value: "one" },
      project,
    );
    try {
      expect(created.value).toBe("one");
      const updated = await variables.update(
        created.id,
        { value: "two" },
        project,
      );
      expect(updated.value).toBe("two");
      const listed = await collect(variables.list({ project }));
      expect(listed.some((v) => v.id === created.id)).toBe(true);
    } finally {
      await variables.delete(created.id, project);
    }
    const listed = await collect(variables.list({ project }));
    expect(listed.some((v) => v.id === created.id)).toBe(false);
  });

  it("integrations CRUD walk", async (ctx) => {
    const integrations = (await liveClient(ctx, "session")).integrations;

    // One live integration per type per org: a create returns the pending
    // one if it exists, and 409s on an active one.
    let created;
    try {
      created = await integrations.create({
        type: "custom",
        name: unique("integration"),
      });
    } catch (error) {
      if (error instanceof IntrospectionAPIError && error.status === 409) {
        ctx.skip("the org already has an active custom integration");
      }
      throw error;
    }
    try {
      expect(created.status).toBe("pending");
      await integrations.get(created.id);
      const listed = await collect(integrations.list());
      expect(listed.some((i) => i.id === created.id)).toBe(true);
      const renamed = unique("integration-renamed");
      const updated = await integrations.update(created.id, { name: renamed });
      expect(updated.name).toBe(renamed);
    } finally {
      await integrations.delete(created.id);
    }
    await expectStatus(integrations.get(created.id), NotFoundError, 404);
  });

  it("judges read and update walk", async (ctx) => {
    const judges = (await liveClient(ctx, "session")).judges;
    const project = setting(ctx, "INTROSPECTION_PROJECT");

    const listed = await collect(judges.list({ project }));
    await expectStatus(judges.get(randomUUID(), project), NotFoundError, 404);
    // Judges are published with a Recipe, so a project without one has none
    // to read; the update writes back the judge's own values.
    const judge = listed[0];
    if (!judge) ctx.skip("the project has no judges");
    const fetched = await judges.get(judge.id, project);
    const updated = await judges.update(
      judge.id,
      { enabled: fetched.enabled, sample_rate: fetched.sample_rate },
      project,
    );
    expect(updated.enabled).toBe(fetched.enabled);
  });

  // --- eval resources: a member's Data Plane token (images:*, tasks:exec) --

  it("images CRUD walk", async (ctx) => {
    const images = (await liveClient(ctx, "member")).images;

    await collect(images.list());
    await expectStatus(images.get(randomUUID()), NotFoundError, 404);

    // A digest no registry serves: the create only records intent, and the
    // build it sends fails on the row without touching anything else.
    let created;
    try {
      created = await images.create({
        name: unique("image"),
        source: {
          kind: "mirror",
          reference: `registry.invalid/sdk/live@sha256:${"0".repeat(64)}`,
        },
      });
    } catch (error) {
      if (error instanceof ValidationError && error.status === 422) {
        ctx.skip("evals are not enabled on this plane");
      }
      throw error;
    }
    expect(created.kind).toBe("service");
    await images.get(created.id);
    await images.delete(created.id);
    await expectStatus(images.get(created.id), NotFoundError, 404);
  });

  it("task commands reads", async (ctx) => {
    const commands = (await liveClient(ctx, "member")).tasks.commands;
    const taskId = randomUUID();

    // A command needs an eval task with a live sandbox, which the seed does
    // not run; these pin the routes, the credential and the error shapes.
    expect(await collect(commands.list(taskId))).toEqual([]);
    await expectStatus(
      commands.get(taskId, randomUUID(), { wait_seconds: 1 }),
      NotFoundError,
      404,
    );
    // 404 for the missing task, or 422 on a plane without evals.
    const status = await rejectionStatus(
      commands.create(taskId, { kind: "exec", command: ["true"] }),
    );
    expect([404, 422]).toContain(status);
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
