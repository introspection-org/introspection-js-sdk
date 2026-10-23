/**
 * The SDK end-to-end walk: one ordered scenario from a clean project to a
 * graded eval, every step an SDK call, recorded once against a local stack
 * and replayed here (introspection-cloud `docs/design/sdk-end-to-end-walk.md`).
 *
 * Replay (the default `pnpm test`) needs no stack. A live run needs a signed-in
 * `introspection login` (or `INTROSPECTION_CP_SESSION`) against the target:
 *
 *   POLLY_MODE=record pnpm vitest run walk/        # re-record the HAR
 *   POLLY_MODE=passthrough pnpm vitest run walk/   # live, records nothing
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Polly } from "@pollyjs/core";
import {
  IntrospectionClient,
  NotFoundError,
} from "@introspection-sdk/introspection-node";
import type {
  Connector,
  Recipe,
  Repository,
  Runtime,
} from "@introspection-sdk/types";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPollyMode, setupPolly } from "../polly-setup";
import {
  followAuthorization,
  hasCompleteRecording,
  prompt,
  pushRecipe,
  raw,
  settled,
  stable,
  Steps,
  WALK,
  walkSettings,
  type WalkSettings,
} from "./support";
import type {
  Application,
  ApplicationSecret,
  Credential,
  Endpoint,
  Integration,
  Paginated,
  Project,
  Variable,
} from "./types";

const RECORDING = "walk";
const STEP_TIMEOUT = 10 * 60_000;
const BAKE_TIMEOUT = 30 * 60_000;
const RECORDINGS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../recordings",
);
const mode = getPollyMode();

/**
 * Every scope a service-account application may hold that the walk uses:
 * everything a person sets a project up with except creating the project and
 * managing members. `git:*`, `remotes:connect`, `members:read` and
 * `annotations:write` are CLI-only and cannot be granted to an application.
 */
const APPLICATION_SCOPES = [
  "projects:read",
  "repositories:read",
  "repositories:write",
  "repositories:delete",
  "recipes:read",
  "recipes:write",
  "runtimes:read",
  "runtimes:write",
  "experiments:read",
  "experiments:write",
  "tasks:read",
  "tasks:write",
  "tasks:delete",
  "tasks:eval",
  "tasks:exec",
  "files:read",
  "files:write",
  "files:delete",
  "conversations:read",
  "events:read",
  "metrics:read",
  "shares:read",
  "shares:write",
  "shares:delete",
  "connectors:read",
  "connectors:write",
  "connections:read",
  "connections:write",
  "connections:delete",
  "automations:read",
  "automations:write",
  "annotations:read",
  "images:read",
  "images:write",
  "api_keys:read",
  "api_keys:write",
  "api_keys:delete",
  "applications:read",
  "applications:write",
  "applications:delete",
  "credentials:read",
  "credentials:write",
  "credentials:delete",
  "endpoints:read",
  "endpoints:write",
  "endpoints:delete",
  "variables:read",
  "variables:write",
  "variables:delete",
  "judges:read",
  "judges:write",
  "telemetry:write",
];

// Replay runs only against a recording that reaches the teardown; until the
// walk records that far, `pnpm test` skips it rather than failing on a
// partial HAR. Live runs (record, passthrough) always run.
const replayable =
  mode !== "replay" || hasCompleteRecording(RECORDINGS_DIR, RECORDING);

const walk = replayable ? describe.sequential : describe.skip;

walk("SDK end-to-end walk", () => {
  let polly: Polly | null = null;
  let settings: WalkSettings;
  const steps = new Steps();

  /** The signed-in owner: creates the project and the service account. */
  let owner: IntrospectionClient;
  /** The walk's own service account in its own project, from step 2 on. */
  let sa: IntrospectionClient;
  let project: Project;
  let application: Application;
  let repository: Repository;
  let memberToken: string;
  let recipe: Recipe;
  let connector: Connector;
  let runtime: Runtime;
  let endpoint: Endpoint;

  beforeAll(() => {
    polly = setupPolly({ recordingName: RECORDING });
    settings = walkSettings(mode);
    owner = new IntrospectionClient({
      cpSession: settings.cpSession,
      advanced: { baseApiUrl: settings.baseApiUrl },
    });
  });

  afterAll(async () => {
    await polly?.stop();
  }, STEP_TIMEOUT);

  it(
    "0: a clean slate — the walk's project is gone before it starts",
    async (ctx) => {
      await steps.run(ctx, "clean slate", async () => {
        const cp = raw(owner.cpHttp);
        const existing = await cp
          .get<Project>(`/v1/projects/${WALK.projectSlug}`)
          .catch((err: unknown) => {
            if (err instanceof NotFoundError) return null;
            throw err;
          });
        if (existing) await cp.delete(`/v1/projects/${existing.id}`);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "1: project — create, read, list, update",
    async (ctx) => {
      await steps.run(ctx, "project", async () => {
        const cp = raw(owner.cpHttp);
        const deploymentId =
          settings.deploymentId ??
          (await cp.get<Project>(`/v1/projects/${settings.bootstrapProjectId}`))
            .deployment_id;
        project = await cp.post<Project>("/v1/projects", {
          name: WALK.projectName,
          slug: WALK.projectSlug,
          deployment_id: deploymentId,
        });
        expect(stable(project)).toMatchInlineSnapshot(`
        {
          "created_by_member_id": "[uuid]",
          "deployment_id": "[uuid]",
          "description": null,
          "id": "[uuid]",
          "name": "SDK coverage",
          "org_id": "[uuid]",
          "settings": null,
          "slug": "sdk-coverage",
        }
      `);

        const read = await cp.get<Project>(`/v1/projects/${project.id}`);
        expect(read.slug).toBe(WALK.projectSlug);

        const listed = await cp.get<Paginated<Project>>("/v1/projects");
        expect(listed.records.some((p) => p.id === project.id)).toBe(true);

        const updated = await cp.patch<Project>(`/v1/projects/${project.id}`, {
          description: "The SDK end-to-end walk's project",
        });
        expect(stable(updated)).toMatchInlineSnapshot(`
        {
          "created_by_member_id": "[uuid]",
          "deployment_id": "[uuid]",
          "description": "The SDK end-to-end walk's project",
          "id": "[uuid]",
          "name": "SDK coverage",
          "org_id": "[uuid]",
          "settings": null,
          "slug": "sdk-coverage",
        }
      `);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "2: application — a service account, its secret, and the token that names the Data Plane",
    async (ctx) => {
      await steps.run(ctx, "application", async () => {
        const cp = raw(owner.cpHttp);
        const query = { project: project.id };
        application = await cp.post<Application>(
          "/v1/applications",
          {
            name: WALK.applicationName,
            application_type: "service_account",
            allowed_scopes: APPLICATION_SCOPES,
          },
          query,
        );
        expect(stable(application)).toMatchInlineSnapshot(`
        {
          "agent_member_id": "[uuid]",
          "allowed_grants": [
            "client_credentials",
          ],
          "allowed_origins": [],
          "allowed_scopes": [
            "projects:read",
            "repositories:read",
            "repositories:write",
            "repositories:delete",
            "recipes:read",
            "recipes:write",
            "runtimes:read",
            "runtimes:write",
            "experiments:read",
            "experiments:write",
            "tasks:read",
            "tasks:write",
            "tasks:delete",
            "tasks:eval",
            "tasks:exec",
            "files:read",
            "files:write",
            "files:delete",
            "conversations:read",
            "events:read",
            "metrics:read",
            "shares:read",
            "shares:write",
            "shares:delete",
            "connectors:read",
            "connectors:write",
            "connections:read",
            "connections:write",
            "connections:delete",
            "automations:read",
            "automations:write",
            "annotations:read",
            "images:read",
            "images:write",
            "api_keys:read",
            "api_keys:write",
            "api_keys:delete",
            "applications:read",
            "applications:write",
            "applications:delete",
            "credentials:read",
            "credentials:write",
            "credentials:delete",
            "endpoints:read",
            "endpoints:write",
            "endpoints:delete",
            "variables:read",
            "variables:write",
            "variables:delete",
            "judges:read",
            "judges:write",
            "telemetry:write",
          ],
          "application_type": "service_account",
          "client_id": "[redacted]",
          "created_at": "[timestamp]",
          "created_by_member_id": "[uuid]",
          "environment": "production",
          "id": "[uuid]",
          "last_used_at": null,
          "name": "sdk-coverage-walk",
          "org_id": "[uuid]",
          "project_id": "[uuid]",
          "redirect_uris": [],
          "revoked_at": null,
          "updated_at": "[timestamp]",
        }
      `);

        const first = await cp.post<ApplicationSecret>(
          `/v1/applications/${application.id}/secrets`,
          { name: "first" },
          query,
        );
        expect(first.secret, "the plaintext is returned once").toBeTruthy();

        sa = await IntrospectionClient.fromServiceAccount({
          clientId: application.client_id,
          clientSecret: first.secret!,
          project: project.id,
          baseApiUrl: settings.baseApiUrl,
        });
        expect(
          sa.advancedOptions.dpUrl,
          "the token response names the Data Plane",
        ).toBeTruthy();

        const listed = await cp.get<Paginated<Application>>(
          "/v1/applications",
          query,
        );
        expect(listed.records.some((a) => a.id === application.id)).toBe(true);
        const read = await cp.get<Application>(
          `/v1/applications/${application.id}`,
          query,
        );
        expect(read.client_id).toBe(application.client_id);
        const renamed = await cp.patch<Application>(
          `/v1/applications/${application.id}`,
          { name: `${WALK.applicationName}-renamed` },
          query,
        );
        expect(renamed.name).toBe(`${WALK.applicationName}-renamed`);

        // Rotate: a second secret, then the first revoked.
        const second = await cp.post<ApplicationSecret>(
          `/v1/applications/${application.id}/secrets`,
          { name: "second" },
          query,
        );
        const secrets = await cp.get<Paginated<ApplicationSecret>>(
          `/v1/applications/${application.id}/secrets`,
          query,
        );
        expect(stable(secrets.records.map(({ secret: _, ...rest }) => rest)))
          .toMatchInlineSnapshot(`
            [
              {
                "application_id": "[uuid]",
                "created_at": "[timestamp]",
                "created_by_member_id": "[uuid]",
                "disabled_at": null,
                "expires_at": null,
                "id": "[uuid]",
                "last_used_at": null,
                "name": "second",
                "org_id": "[uuid]",
                "secret_prefix": "intro_sk_8Ggh2D8U",
                "secret_suffix": "bUp4",
                "status": "active",
                "updated_at": "[timestamp]",
              },
              {
                "application_id": "[uuid]",
                "created_at": "[timestamp]",
                "created_by_member_id": "[uuid]",
                "disabled_at": null,
                "expires_at": null,
                "id": "[uuid]",
                "last_used_at": null,
                "name": "first",
                "org_id": "[uuid]",
                "secret_prefix": "intro_sk_aRB3ajME",
                "secret_suffix": "6Kh4",
                "status": "active",
                "updated_at": "[timestamp]",
              },
            ]
          `);
        await cp.delete(
          `/v1/applications/${application.id}/secrets/${first.id}`,
          query,
        );
        expect(second.id).not.toBe(first.id);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "3: repository — a hosted repository the walk pushes the recipe into",
    async (ctx) => {
      await steps.run(ctx, "repository", async () => {
        const cp = raw(sa.cpHttp);
        const created = await cp.post<Repository>(
          "/v1/repositories",
          { provider: "hosted", slug: WALK.recipeSlug, default_branch: "main" },
          { project: project.id },
        );
        expect(
          created.url,
          "the credential-free Git transport URL",
        ).toBeTruthy();
        expect(stable(created)).toMatchInlineSnapshot(`
        {
          "created_at": "[timestamp]",
          "default_branch": "main",
          "head_commit_sha": null,
          "id": "[uuid]",
          "integration_id": null,
          "is_recipe_source": false,
          "name": "harbor-hello-mcp",
          "project_id": "[uuid]",
          "provider": "introspection",
          "provisioning_status": "pending",
          "pushed_at": null,
          "seed_template": "pi-agent",
          "slug": "harbor-hello-mcp",
          "url": "[url]",
        }
      `);

        // The owner's Data Plane token, minted for the walk's project: it
        // carries `git:push`, which no service account can, and later the
        // member-only Data Plane writes (annotations).
        const minted = await raw(owner.cpHttp).post<{
          access_token: string;
          project_id: string;
        }>("/v1/tokens", { project: project.id, expires_hours: 24 });
        memberToken = minted.access_token;
        expect(minted.project_id).toBe(project.id);
        if (mode !== "replay") {
          pushRecipe(
            { url: settings.recipeRepositoryUrl, ref: settings.recipeGitRef },
            { url: created.url!, bearer: memberToken },
          );
        }
        // A hosted repository reads `ready` once its first push has landed.
        repository = await settled(
          polly!,
          mode,
          () => sa.repositories.get(created.id, { project: project.id }),
          (r) =>
            r.provisioning_status === "ready" ||
            r.provisioning_status === "failed",
          { timeoutMs: 120_000, intervalMs: 2_000, label: "hosted repository" },
        );
        expect(repository.provisioning_status).toBe("ready");

        const listed = await sa.repositories.list({
          project: project.id,
          slug: WALK.recipeSlug,
        });
        expect(listed.some((r) => r.id === repository.id)).toBe(true);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "4: recipe — create from the repository at a pinned commit, read, list, update",
    async (ctx) => {
      await steps.run(ctx, "recipe", async () => {
        const cp = raw(sa.cpHttp);
        const page = await sa.repositories.commits(repository.id, {
          sha: "main",
        });
        const head = page.records[0];
        expect(head?.sha, "a commit on the hosted main").toBeTruthy();
        const detail = await sa.repositories.commit(repository.id, head!.sha);
        expect(detail.sha).toBe(head!.sha);
        const dp = raw(sa.dpHttp);
        const branches = await dp.get<Paginated<{ name: string }>>(
          `/v1/repositories/${repository.id}/branches`,
        );
        expect(
          branches.records.some((b) => b.name === "main"),
        ).toBe(true);
        const entry = await dp.get<{ path: string; type: string }>(
          `/v1/repositories/${repository.id}/contents/agents/scripted.yaml`,
          { ref: head!.sha },
        );
        expect(entry.path).toBe("agents/scripted.yaml");

        recipe = await cp.post<Recipe>("/v1/recipes", {
          project_id: project.id,
          repository_id: repository.id,
          name: "Harbor hello-mcp",
          slug: WALK.recipeSlug,
          git_ref: "main",
          git_commit_sha: head!.sha,
        });
        expect(stable(recipe)).toMatchInlineSnapshot(`
          {
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "description": null,
            "git_commit_sha": "[sha]",
            "git_commit_subject": null,
            "git_ref": "main",
            "id": "[uuid]",
            "mcp_servers": null,
            "name": "Harbor hello-mcp",
            "org_id": "[uuid]",
            "policies": null,
            "project_id": "[uuid]",
            "repository_id": "[uuid]",
            "slug": "harbor-hello-mcp",
            "sub_path": null,
            "updated_at": "[timestamp]",
            "validation": {
              "checked_at": null,
              "diagnostics": [],
              "error_message": null,
              "status": "pending",
              "validator_name": null,
              "validator_version": null,
            },
          }
        `);

        const read = await sa.recipes.get(recipe.id);
        expect(read.slug).toBe(WALK.recipeSlug);
        let seen = false;
        for await (const item of sa.recipes.list({ project: project.id })) {
          if (item.id === recipe.id) seen = true;
        }
        expect(seen).toBe(true);
        const updated = await cp.patch<Recipe>(`/v1/recipes/${recipe.id}`, {
          description: "The walk's recipe",
        });
        expect(updated.description).toBe("The walk's recipe");
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "5: credential and variable — a write-only secret and a value the sandbox reads",
    async (ctx) => {
      await steps.run(ctx, "credential and variable", async () => {
        const cp = raw(sa.cpHttp);
        const query = { project: project.id };
        const credential = await cp.post<Credential>(
          "/v1/credentials",
          { name: WALK.credentialName, secret: WALK.credentialSecret },
          query,
        );
        expect(
          credential.secret ?? null,
          "a secret never reads back",
        ).toBeNull();
        expect(stable(credential)).toMatchInlineSnapshot(`
          {
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "environment": null,
            "has_secret": true,
            "id": "[uuid]",
            "name": "WALK_SECRET",
            "org_id": "[uuid]",
            "project_id": "[uuid]",
            "runtime_group_id": null,
            "runtime_id": null,
            "secret_display": "walk***0001",
            "secret_set_at": "[timestamp]",
            "updated_at": "[timestamp]",
          }
        `);
        const credentials = await cp.get<Paginated<Credential>>(
          "/v1/credentials",
          query,
        );
        expect(credentials.records.some((c) => c.id === credential.id)).toBe(
          true,
        );
        const readCredential = await cp.get<Credential>(
          `/v1/credentials/${credential.id}`,
          query,
        );
        expect(readCredential.name).toBe(WALK.credentialName);
        await cp.patch<Credential>(
          `/v1/credentials/${credential.id}`,
          { secret: `${WALK.credentialSecret}-rotated` },
          query,
        );

        const variable = await cp.post<Variable>(
          "/v1/variables",
          { name: WALK.variableName, kind: "value", value: WALK.variableValue },
          query,
        );
        expect(stable(variable)).toMatchInlineSnapshot(`
          {
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "environment": null,
            "id": "[uuid]",
            "kind": "value",
            "name": "WALK_MARKER",
            "org_id": "[uuid]",
            "project_id": "[uuid]",
            "runtime_group_id": null,
            "runtime_id": null,
            "updated_at": "[timestamp]",
            "value": "walk-marker-7f3a",
          }
        `);
        const variables = await cp.get<Paginated<Variable>>(
          "/v1/variables",
          query,
        );
        expect(variables.records.some((v) => v.id === variable.id)).toBe(true);
        const updated = await cp.patch<Variable>(
          `/v1/variables/${variable.id}`,
          { value: WALK.variableValue },
          query,
        );
        expect(updated.value).toBe(WALK.variableValue);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "6: connector — the public MCP reference server, discovered",
    async (ctx) => {
      await steps.run(ctx, "connector", async () => {
        const discovered = await sa.connectors.discoverOAuth(WALK.mcpIssuer);
        expect(
          discovered.authorization_endpoint,
          "the issuer publishes its metadata",
        ).toBeTruthy();
        connector = await sa.connectors.create({
          name: WALK.connectorName,
          slug: WALK.connectorName,
          provider: WALK.connectorName,
          auth_mode: "oauth_stored",
          issuer: WALK.mcpIssuer,
          authorization_endpoint: discovered.authorization_endpoint,
          token_endpoint: discovered.token_endpoint,
          api_hosts: [new URL(WALK.mcpEndpoint).host],
          client_id: discovered.client_id ?? undefined,
          client_secret: discovered.client_secret ?? undefined,
        } as Parameters<typeof sa.connectors.create>[0]);
        expect(stable(connector)).toMatchInlineSnapshot(`
          {
            "agent_member_id": "[uuid]",
            "api_hosts": [
              "example-server.modelcontextprotocol.io",
            ],
            "application_id": null,
            "assertion_audience": null,
            "auth_mode": "oauth_stored",
            "authorization_endpoint": "[url]",
            "client_id": "[uuid]",
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "environment": "production",
            "id": "[uuid]",
            "metadata": {},
            "name": "hello-mcp",
            "org_id": "[uuid]",
            "person_server_url": null,
            "policy_entities": null,
            "project_id": "[uuid]",
            "provider": "hello-mcp",
            "requires_runtime": false,
            "scopes": [],
            "slug": "hello-mcp",
            "status": "pending",
            "token_endpoint": "[url]",
            "updated_at": "[timestamp]",
            "webhook_url": null,
          }
        `);
        const read = await sa.connectors.get(connector.id);
        expect(read.slug).toBe(WALK.connectorName);
        let seen = false;
        for await (const item of sa.connectors.list())
          if (item.id === connector.id) seen = true;
        expect(seen).toBe(true);
        const updated = await sa.connectors.update(connector.id, {
          name: `${WALK.connectorName} (walk)`,
        });
        expect(updated.name).toBe(`${WALK.connectorName} (walk)`);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "7: runtime — created from the recipe and baked",
    async (ctx) => {
      await steps.run(ctx, "runtime", async () => {
        const cp = raw(sa.cpHttp);
        const created = await cp.post<Runtime>("/v1/runtimes", {
          project: project.id,
          recipe_id: recipe.id,
          name: WALK.runtimeSlug,
          slug: WALK.runtimeSlug,
          config_json: { connectors: [WALK.connectorName] },
        });
        expect(stable(created)).toMatchInlineSnapshot(`
          {
            "config_json": {
              "connectors": [
                "hello-mcp",
              ],
            },
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "description": null,
            "environment_ref": null,
            "environments": [
              "staging",
              "production",
            ],
            "id": "[uuid]",
            "image_build_error_message": null,
            "image_build_metadata": {},
            "image_build_status": "pending",
            "kind": "byor",
            "llm_mode": "managed",
            "name": "sdk-coverage-runtime",
            "org_id": "[uuid]",
            "project_id": "[uuid]",
            "recipe_id": "[uuid]",
            "recipe_kind": "production",
            "recipe_ref": "main",
            "runtime_group_id": "[uuid]",
            "slug": "sdk-coverage-runtime",
            "updated_at": "[timestamp]",
            "yanked_at": null,
            "yanked_reason": null,
          }
        `);
        runtime = await settled(
          polly!,
          mode,
          () => sa.runtimes.get(created.id),
          (r) =>
            r.image_build_status === "ready" ||
            r.image_build_status === "failed",
          { timeoutMs: 20 * 60_000, intervalMs: 10_000, label: "runtime bake" },
        );
        expect(
          runtime.image_build_status,
          runtime.image_build_error_message ?? "",
        ).toBe("ready");
        let seen = false;
        for await (const item of sa.runtimes.list({
          project: project.id,
          runtime: WALK.runtimeSlug,
        })) {
          if (item.id === runtime.id) seen = true;
        }
        expect(seen).toBe(true);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "8: connection and endpoint — the grant binds hello-mcp to the runtime",
    async (ctx) => {
      await steps.run(ctx, "connection and endpoint", async () => {
        const returnUrl = `${settings.baseApiUrl}/walk/connected`;
        const started = await sa.connectors.authorize(connector.id, {
          runtime: runtime.runtime_group_id,
          return_url: returnUrl,
          binding: {
            environment: "production",
            mcp_server_id: WALK.mcpServerId,
            url: WALK.mcpEndpoint,
          },
        } as Parameters<typeof sa.connectors.authorize>[1]);
        expect(started.authorize_url).toBeTruthy();
        const landed = await followAuthorization(
          started.authorize_url,
          { baseApiUrl: settings.baseApiUrl, cookie: settings.cpSession },
          returnUrl,
        );
        expect(landed.searchParams.get("status")).toBe("active");
        const connectionId = landed.searchParams.get("connection_id")!;
        const connection = await sa.connectors.connections.get(
          connector.id,
          connectionId,
        );
        expect(stable(connection)).toMatchInlineSnapshot();
        let seen = false;
        for await (const item of sa.connectors.connections.list(connector.id))
          if (item.id === connectionId) seen = true;
        expect(seen).toBe(true);

        const cp = raw(sa.cpHttp);
        const endpoints = await cp.get<Paginated<Endpoint>>("/v1/endpoints", {
          project: project.id,
          mcp_server_id: WALK.mcpServerId,
        });
        endpoint = endpoints.records[0]!;
        expect(stable(endpoint)).toMatchInlineSnapshot();
        const read = await cp.get<Endpoint>(`/v1/endpoints/${endpoint.id}`, {
          project: project.id,
        });
        expect(read.kind).toBe("mcp");
        const renamed = await cp.patch<Endpoint>(
          `/v1/endpoints/${endpoint.id}`,
          { name: "hello-mcp (walk)" },
          { project: project.id },
        );
        expect(renamed.name).toBe("hello-mcp (walk)");

        const requirements = await sa.runtimes.get(runtime.id);
        expect(stable(requirements.mcp_requirements)).toMatchInlineSnapshot();
      });
    },
    STEP_TIMEOUT,
  );
});
