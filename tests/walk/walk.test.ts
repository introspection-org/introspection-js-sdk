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
  type Runner,
} from "@introspection-sdk/introspection-node";
import type {
  Automation,
  Connector,
  Experiment,
  File as IntrospectionFile,
  Recipe,
  Repository,
  Runtime,
  Task,
} from "@introspection-sdk/types";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPollyMode, setupPolly } from "../polly-setup";
import {
  followAuthorization,
  hasCompleteRecording,
  prompt,
  pushRecipe,
  secondTurn,
  raw,
  settled,
  stable,
  Steps,
  WALK,
  walkSettings,
  type WalkSettings,
} from "./support";
import type {
  ApiKey,
  Application,
  ApplicationSecret,
  Credential,
  Endpoint,
  Integration,
  Judge,
  Paginated,
  Project,
  TaskCommand,
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
  /** The walk's own pin of the same commit: a runtime version's identity is (group, recipe). */
  let pinnedRecipe: Recipe;
  let connector: Connector;
  let runtime: Runtime;
  let endpoint: Endpoint;
  let runtimeV2: Runtime;
  let runner: Runner;
  let inputFile: IntrospectionFile;
  let task: Task;
  let conversationId: string;
  let outputFile: IntrospectionFile;
  let evalTask: Task;
  let judge: Judge;
  let experiment: Experiment;
  let automation: Automation;
  let apiKey: ApiKey;

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
                "secret_prefix": "intro_sk_8IHu5jLt",
                "secret_suffix": "DIdo",
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
                "secret_prefix": "intro_sk_ytFtFjlh",
                "secret_suffix": "CUJk",
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
            "name": "hello-mcp",
            "project_id": "[uuid]",
            "provider": "introspection",
            "provisioning_status": "pending",
            "pushed_at": null,
            "seed_template": "pi-agent",
            "slug": "hello-mcp",
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

        // Provisioning seeds the hosted copy with the deployment's template and
        // reports it; that first push pins a recipe. A runtime made from it
        // registers the group's slug, which is what lets the next push
        // version the group and sync its judges (hosted-recipe-git.md).
        repository = await settled(
          polly!,
          mode,
          () => sa.repositories.get(created.id, { project: project.id }),
          (r) => r.provisioning_status === "ready" || r.provisioning_status === "failed",
          { timeoutMs: 180_000, intervalMs: 2_000, label: "hosted repository" },
        );
        expect(repository.provisioning_status).toBe("ready");
        const seeded = await settled(
          polly!,
          mode,
          async () => {
            const out: Recipe[] = [];
            for await (const r of sa.recipes.list({ project: project.id })) out.push(r);
            return out;
          },
          (rows) => rows.some((r) => r.repository_id === repository.id),
          { timeoutMs: 180_000, intervalMs: 3_000, label: "seed recipe" },
        );
        const seedRecipe = seeded.find((r) => r.repository_id === repository.id)!;
        const seedRuntime = await cp.post<Runtime>("/v1/runtimes", {
          project: project.id,
          recipe_id: seedRecipe.id,
          name: WALK.runtimeSlug,
          slug: WALK.runtimeSlug,
        });
        expect(seedRuntime.slug).toBe(WALK.runtimeSlug);

        if (mode !== "replay") {
          pushRecipe(
            { url: settings.recipeRepositoryUrl, ref: settings.recipeGitRef },
            { url: created.url!, bearer: memberToken },
          );
        }

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
        expect(branches.records.some((b) => b.name === "main")).toBe(true);
        const entry = await dp.get<{ path: string; type: string }>(
          `/v1/repositories/${repository.id}/contents/agents/scripted.yaml`,
          { ref: head!.sha },
        );
        expect(entry.path).toBe("agents/scripted.yaml");

        // The push versioned the manifest's recipe at the pushed commit; the
        // create below names the same pin and answers with that row.
        const versioned = await settled(
          polly!,
          mode,
          async () => {
            const out: Recipe[] = [];
            for await (const r of sa.recipes.list({ project: project.id })) out.push(r);
            return out.find((r) => r.git_commit_sha === head!.sha) ?? null;
          },
          (r) => r !== null,
          { timeoutMs: 180_000, intervalMs: 3_000, label: "push-versioned recipe" },
        );
        recipe = versioned!;
        expect(stable(recipe)).toMatchInlineSnapshot(`
          {
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "description": "Harbor E2B task calling a development MCP server",
            "git_commit_sha": "[sha]",
            "git_commit_subject": null,
            "git_ref": "main",
            "id": "[uuid]",
            "mcp_servers": [
              {
                "id": "[redacted]",
                "required": true,
                "tools": {
                  "exclude": [],
                  "include": [
                    "echo",
                  ],
                },
              },
            ],
            "name": "hello-mcp",
            "org_id": "[uuid]",
            "policies": null,
            "project_id": "[uuid]",
            "repository_id": "[uuid]",
            "slug": "hello-mcp-production-main-a8db04a2e4d1",
            "sub_path": ".",
            "updated_at": "[timestamp]",
            "validation": {
              "checked_at": "[timestamp]",
              "diagnostics": [],
              "error_message": null,
              "status": "valid",
              "validator_name": "introspection-recipe-check",
              "validator_version": "0.12.0",
            },
          }
        `);
        // A second pin of the same commit under the walk's own name: the
        // create mints a recipe row per pin, so this is a sibling of the
        // push's, not the same row.
        pinnedRecipe = await cp.post<Recipe>("/v1/recipes", {
          project_id: project.id,
          repository_id: repository.id,
          name: "hello-mcp (walk pin)",
          git_ref: "main",
          git_commit_sha: head!.sha,
        });
        expect(pinnedRecipe.git_commit_sha).toBe(head!.sha);
        expect(pinnedRecipe.id).not.toBe(recipe.id);

        const read = await sa.recipes.get(recipe.id);
        expect(read.slug).toBe(recipe.slug);
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
        // Naming the issuer alone makes the Control Plane discover the
        // endpoints, register a client dynamically and record PKCE support;
        // endpoints passed by hand would skip that and the grant would fail.
        connector = await sa.connectors.create({
          name: WALK.connectorName,
          slug: WALK.connectorName,
          provider: WALK.connectorName,
          auth_mode: "oauth_stored",
          issuer: WALK.mcpIssuer,
          api_hosts: [new URL(WALK.mcpEndpoint).host],
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
            "metadata": {
              "issuer": "[url]",
              "oauth": {
                "client_registration": "dynamic",
                "code_challenge_methods_supported": [
                  "S256",
                ],
                "registration_endpoint": "[url]",
                "resource": "[url]",
                "token_endpoint_auth_methods_supported": [
                  "none",
                ],
              },
            },
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
        // The push versioned the group at the recipe's commit; that version
        // is the runtime the walk runs on, and the API creates the next one.
        const versioned = await settled(
          polly!,
          mode,
          async () => {
            const out: Runtime[] = [];
            for await (const r of sa.runtimes.list({ project: project.id, runtime: WALK.runtimeSlug })) {
              out.push(r);
            }
            return out.find((r) => r.recipe_id === recipe.id) ?? null;
          },
          (r) => r !== null && (r.image_build_status === "ready" || r.image_build_status === "failed"),
          { timeoutMs: BAKE_TIMEOUT, intervalMs: 10_000, label: "push-versioned runtime bake" },
        );
        runtime = versioned!;
        expect(runtime.image_build_status, runtime.image_build_error_message ?? "").toBe("ready");
        expect(stable(runtime)).toMatchInlineSnapshot(`
          {
            "config_json": {
              "connectors": [
                "hello-mcp",
              ],
            },
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "description": "Harbor E2B task calling a development MCP server",
            "environment_ref": null,
            "environments": [
              "staging",
              "production",
            ],
            "id": "[uuid]",
            "image_build_error_message": null,
            "image_build_metadata": {
              "built_at": "[timestamp]",
              "external_image_name": "intro-6864c641-5bf2-50ca-9bea-090f37e685eb-a8db04a2e4d1",
              "image_tag": "host.docker.internal:5001/sandbox-builds:01a13d6d-f05f-7115-9cc9-4b168ba5d22d-6864c641-5bf-a8db04a2e4d1-683127baeffe",
              "size_bytes": 15427,
              "verdict_by": "[timestamp]",
            },
            "image_build_status": "ready",
            "kind": "byor",
            "llm_mode": "managed",
            "name": "hello-mcp",
            "org_id": "[uuid]",
            "project_id": "[uuid]",
            "recipe_id": "[uuid]",
            "recipe_kind": "production",
            "recipe_ref": "main",
            "runtime_group_id": "[uuid]",
            "slug": "hello-mcp",
            "updated_at": "[timestamp]",
            "yanked_at": null,
            "yanked_reason": null,
          }
        `);

        // A version's identity in its group is its recipe, so the next
        // version pins the walk's own recipe of the same commit.
        const created = await cp.post<Runtime>("/v1/runtimes", {
          project: project.id,
          recipe_id: pinnedRecipe.id,
          name: WALK.runtimeSlug,
          slug: WALK.runtimeSlug,
          config_json: { connectors: [WALK.connectorName] },
        });
        expect(created.runtime_group_id).toBe(runtime.runtime_group_id);
        runtimeV2 = await settled(
          polly!,
          mode,
          () => sa.runtimes.get(created.id),
          (r) => r.image_build_status === "ready" || r.image_build_status === "failed",
          { timeoutMs: BAKE_TIMEOUT, intervalMs: 10_000, label: "runtime bake" },
        );
        expect(runtimeV2.image_build_status, runtimeV2.image_build_error_message ?? "").toBe("ready");
        let seen = false;
        for await (const item of sa.runtimes.list({
          project: project.id,
          runtime: WALK.runtimeSlug,
        })) {
          // The list serves the group's live version, the newest one.
          if (item.runtime_group_id === runtime.runtime_group_id) seen = true;
        }
        expect(seen).toBe(true);
      });
    },
    BAKE_TIMEOUT,
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
        expect(stable(connection)).toMatchInlineSnapshot(`
          {
            "connector_id": "[uuid]",
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "id": "[uuid]",
            "member_id": null,
            "org_id": "[uuid]",
            "provider_account_id": null,
            "provider_app": null,
            "runtime_group_id": "[uuid]",
            "scopes_granted": [],
            "status": "active",
            "subject_type": "app",
            "token_expires_at": "[timestamp]",
            "updated_at": "[timestamp]",
          }
        `);
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
        expect(stable(endpoint)).toMatchInlineSnapshot(`
          {
            "assertion_claims": null,
            "authorized_application_id": null,
            "base_url": "[url]",
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "credential_refs": [],
            "environment": "production",
            "header_names": [],
            "headers": {},
            "host": "example-server.modelcontextprotocol.io",
            "id": "[uuid]",
            "kind": "mcp",
            "last_verified_at": null,
            "metadata": {
              "auth_audience": null,
              "connector_id": "[uuid]",
              "extra_hosts": [],
              "mcp_server_id": "hello-mcp",
              "provider_app": null,
            },
            "name": "hello-mcp",
            "org_id": "[uuid]",
            "project_id": "[uuid]",
            "runtime_group_id": "[uuid]",
            "runtime_id": null,
            "updated_at": "[timestamp]",
            "verify_path": null,
          }
        `);
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

        const requirements = await cp.get<Runtime>(`/v1/runtimes/${runtime.id}`, {
          include: "mcp_requirements",
        });
        expect(stable(requirements.mcp_requirements)).toMatchInlineSnapshot(
          `[]`,
        );
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "9: files in — an upload the task will find under /workspace/files",
    async (ctx) => {
      await steps.run(ctx, "files in", async () => {
        inputFile = await sa.files.createText({
          name: WALK.inputFileName,
          content: WALK.inputFileText,
          mime_type: "text/plain",
          metadata: { suite: "walk" },
        });
        expect(stable(inputFile)).toMatchInlineSnapshot(`
          {
            "created_at": "[timestamp]",
            "expires_at": null,
            "file_type": "filesystem",
            "generated_output_task_id": null,
            "id": "[uuid]",
            "member_id": "[uuid]",
            "metadata": {
              "blob_checksum": "0e90bfe21ca1588eb625db464fba78d47c540b3027ac2ca6536cd9cec2d932dd",
              "original_filename": "walk-input.txt",
              "suite": "walk",
            },
            "mime_type": "text/plain",
            "name": "walk-input.txt",
            "org_id": "[uuid]",
            "parent_id": null,
            "project_id": "[uuid]",
            "size_bytes": 21,
            "storage_path": "01a13d6d-f05f-7115-9cc9-4b168ba5d22d/01a167eb-ca5a-7314-9cd9-1be2fc1d5ede/files/01a167ec-136f-7175-bebe-2d030b383c90/walk-input.txt",
            "storage_version_id": null,
            "tags": [],
            "task_id": null,
            "updated_at": "[timestamp]",
            "version": 1,
          }
        `);
        const read = await sa.files.get(inputFile.id);
        expect(read.name).toBe(WALK.inputFileName);
        const body = await sa.files.download(inputFile.id);
        expect(new TextDecoder().decode(body)).toBe(WALK.inputFileText);
        const version = await sa.files.versions.create(inputFile.id, {
          file: new TextEncoder().encode(`${WALK.inputFileText} (v2)`),
          name: WALK.inputFileName,
          contentType: "text/plain",
        });
        const versions = await sa.files.versions.list(inputFile.id);
        expect(versions.records.some((v) => v.id === version.id)).toBe(true);
        await sa.files.versions.get(inputFile.id, version.id);
        const updated = await sa.files.update(inputFile.id, {
          metadata: { suite: "walk", stage: "attached" },
        });
        expect(updated.metadata?.stage).toBe("attached");
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "10: task — a runner on the runtime, one turn that calls the MCP and leaves a file",
    async (ctx) => {
      await steps.run(ctx, "task", async () => {
        runner = await sa.runtimes.runById(runtime.id, {
          environment: "production",
          agent_name: settings.agent,
        } as Parameters<typeof sa.runtimes.runById>[1]);
        const started = await runner.tasks.start({
          prompt: prompt(settings),
          agent_name: settings.agent,
          files: [{ id: inputFile.id }],
          metadata: { suite: "walk" },
          idle_timeout_seconds: 180,
        } as Parameters<typeof runner.tasks.start>[0]);
        expect(started.task, "the create returns the task").toBeTruthy();
        const reply = await started.text();
        expect(reply.length, "the turn replied").toBeGreaterThan(0);

        // The stream ends before the row settles; the second turn needs it idle.
        task = await settled(
          polly!,
          mode,
          () => runner.tasks.get(started.task!.id),
          (t) => ["idle", "awaiting_user", "completed"].includes(t.status),
          {
            timeoutMs: 120_000,
            intervalMs: 2_000,
            label: "task after its first turn",
          },
        );
        expect(stable(task)).toMatchInlineSnapshot(`
          {
            "agent": null,
            "automation_id": null,
            "completed_at": null,
            "conversation_metadata": null,
            "created_at": "[timestamp]",
            "display_index": 4,
            "id": "[uuid]",
            "is_archived": false,
            "kind": "agent",
            "last_user_message_at": "[timestamp]",
            "member_id": "[uuid]",
            "metadata": {
              "active_run_delivered": null,
              "active_run_id": null,
              "agent_name": "scripted",
              "agent_session_id": "[uuid]",
              "completion_reason": null,
              "conversation_files": {
                "uploads": [
                  {
                    "id": "[uuid]",
                  },
                ],
              },
              "conversation_id": "[uuid]",
              "crash_restarts": null,
              "error": null,
              "history_recall": null,
              "idle_timeout_seconds": 180,
              "image_build": {
                "build_id": "[uuid]",
                "git_sha": "[sha]",
                "image_digest": "host.docker.internal:5001/sandbox-builds@sha256:f963861469f172e57b4f647d085989f2c2af273d22b40bf2230752eaacc712e0",
                "launch": "baked",
              },
              "invocation_id": "inv_12u4gKg8d7nh3hdIe2klmBzuixOLOjD1bC",
              "last_activity_at": "[timestamp]",
              "last_response": {
                "response_id": "chatcmpl-a74ecfaafc6441238ed2ca247d91a8f1",
                "turn": 1,
                "updated_at": "[timestamp]",
              },
              "latest_run_id": "[uuid]",
              "pending_delivery_id": null,
              "pending_resume": null,
              "runtime_environment": "production",
              "spawn_resolution": {
                "attribution_env": {
                  "INTROSPECTION_ENVIRONMENT": "production",
                  "INTROSPECTION_JUDGES_OPERATIONAL": "{"greeting":{"enabled":true,"sample_rate":1.0,"judge_id":"01a167eb-d774-7110-bea6-9862a80551ac","definition_hash":"459455f76567d23931987f6e51b8709f8aca44f9c8f665a4d861297113406ba9"}}",
                  "INTROSPECTION_RECIPE_ID": "[uuid]",
                  "INTROSPECTION_RECIPE_KIND": "production",
                  "INTROSPECTION_RECIPE_REF": "main",
                  "INTROSPECTION_RUNTIME_GROUP_ID": "[uuid]",
                  "INTROSPECTION_RUNTIME_ID": "[uuid]",
                  "INTROSPECTION_RUNTIME_KIND": "byor",
                  "INTROSPECTION_RUNTIME_NAME": "hello-mcp",
                  "OTEL_SERVICE_NAME": "hello-mcp",
                },
                "contract": {
                  "agent_name": "scripted",
                  "kind": "pinned_git",
                  "recipe_repo": "[uuid]",
                  "recipe_sha": "[sha]",
                },
                "image_reference": null,
                "recipe_resources": null,
                "recipe_sub_path": "",
                "runtime_group_id": "[uuid]",
                "runtime_id": "[uuid]",
              },
              "suite": "walk",
              "task_prompt": null,
              "turn_count": 1,
              "workflow_version": 1,
            },
            "org_id": "[uuid]",
            "project_id": "[uuid]",
            "runtime_group_id": "[uuid]",
            "runtime_id": "[uuid]",
            "started_at": "[timestamp]",
            "status": "idle",
            "tags": [],
            "title": "Call the \`echo\` tool from the declared \`hello-mcp\` MCP server with the message \`hello from the public MCP\`. Write the echoed value exactly, with no quotes or additional formatting, to \`/workspace/outputs/greeting.txt\`. Then run \`echo $WALK_MARKER\` in…",
            "updated_at": "[timestamp]",
          }
        `);
        conversationId = String(
          (task.metadata as Record<string, unknown> | null)?.conversation_id ??
            task.id,
        );
        const run = await runner.tasks.runs.get(task.id, started.run.id);
        expect(run.task_id).toBe(task.id);

        const turn = await runner.tasks.runs.create(task.id, {
          prompt: { text: secondTurn(settings) },
        });
        await turn.text();
        await settled(
          polly!,
          mode,
          () => runner.tasks.get(task.id),
          (t) => ["idle", "awaiting_user", "completed"].includes(t.status),
          {
            timeoutMs: 120_000,
            intervalMs: 2_000,
            label: "task after its second turn",
          },
        );

        let seen = false;
        for await (const item of runner.tasks.list())
          if (item.id === task.id) seen = true;
        expect(seen).toBe(true);
        const retitled = await runner.tasks.update(task.id, {
          title: "The walk's task",
        });
        expect(retitled.title).toBe("The walk's task");
        await runner.tasks.archive(task.id);
        await runner.tasks.unarchive(task.id);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "11: evidence — the output file, the conversation and its items",
    async (ctx) => {
      await steps.run(ctx, "evidence", async () => {
        const outputs = await settled(
          polly!,
          mode,
          async () => {
            const out: IntrospectionFile[] = [];
            for await (const f of sa.files.list({ task_id: task.id }))
              out.push(f);
            return out;
          },
          (files) => files.some((f) => f.name.endsWith(WALK.outputFileName)),
          { timeoutMs: 120_000, intervalMs: 3_000, label: "task output files" },
        );
        outputFile = outputs.find((f) => f.name.endsWith(WALK.outputFileName))!;
        expect(stable(outputFile)).toMatchInlineSnapshot(`
          {
            "created_at": "[timestamp]",
            "expires_at": null,
            "file_type": "filesystem",
            "generated_output_task_id": "[uuid]",
            "id": "[uuid]",
            "member_id": "[uuid]",
            "metadata": {
              "blob_checksum": "548e66e4ed3b79c6587949deca60cdd96c163f1c950dc21a4038c0557f9a145b",
              "conversation_id": "[uuid]",
              "original_filename": "greeting.txt",
              "relative_path": "greeting.txt",
              "task_id": "[uuid]",
            },
            "mime_type": "text/plain",
            "name": "tasks/01a167ec-1430-75de-9f45-2122e1566b6f/outputs/greeting.txt",
            "org_id": "[uuid]",
            "parent_id": null,
            "project_id": "[uuid]",
            "size_bytes": 31,
            "storage_path": "01a13d6d-f05f-7115-9cc9-4b168ba5d22d/01a167eb-ca5a-7314-9cd9-1be2fc1d5ede/files/01a167ec-1fe1-77e2-8adf-e8402c94d141/greeting.txt",
            "storage_version_id": null,
            "tags": [],
            "task_id": "[uuid]",
            "updated_at": "[timestamp]",
            "version": 1,
          }
        `);
        const content = new TextDecoder().decode(
          await sa.files.download(outputFile.id),
        );
        expect(content.trim()).toBe(WALK.echoResult);

        const conversation = await settled(
          polly!,
          mode,
          () => sa.conversations.get(conversationId),
          () => true,
          { timeoutMs: 60_000, label: "conversation" },
        );
        expect(stable(conversation)).toMatchInlineSnapshot(`
          {
            "agents": [
              {
                "depth": 0,
                "id": "[redacted]",
                "name": "scripted",
              },
            ],
            "cost": {
              "usd": 0,
            },
            "created_at": "[timestamp]",
            "environment": "production",
            "id": "[uuid]",
            "metrics": {
              "duration_ms": 641,
              "failed_llm_call_count": 0,
              "failed_tool_use_count": 1,
              "has_errors": false,
              "llm_call_count": 5,
              "max_turn": 2,
              "span_count": 24,
              "tool_use_count": 3,
              "trace_count": 2,
            },
            "object": "conversation",
            "owner": {
              "key": "[redacted]",
            },
            "recipe": {
              "git_commit_sha": "[sha]",
            },
            "runtime": {
              "group_id": "[uuid]",
              "id": "[uuid]",
            },
            "service_name": "hello-mcp",
            "task_title": "The walk's task",
            "updated_at": "[timestamp]",
            "usage": {
              "output_tokens": 66,
              "total_input_tokens": 80,
              "total_tokens": 146,
            },
          }
        `);
        const page = await settled(
          polly!,
          mode,
          async () => await sa.conversations.items.list(conversationId),
          (p) =>
            JSON.stringify(p).includes("echo") &&
            JSON.stringify(p).includes(WALK.variableValue),
          {
            timeoutMs: 120_000,
            intervalMs: 5_000,
            label: "conversation items",
          },
        );
        const items = JSON.stringify(page);
        expect(items, "the hello-mcp echo tool was called").toContain("echo");
        expect(items, "the echo result reached the conversation").toContain(
          WALK.echoResult,
        );
        expect(items, "the variable reached the sandbox").toContain(
          WALK.variableValue,
        );
        const first = page.data[0]!;
        await sa.conversations.items.get(conversationId, first.span_id!);
        let seen = false;
        for await (const c of sa.conversations.list({
          runtime_group_id: runtime.runtime_group_id,
        })) {
          if (c.id === conversationId) seen = true;
        }
        expect(seen).toBe(true);
        const trajectory =
          await sa.conversations.exportTrajectory(conversationId);
        expect(trajectory, "the trajectory export").toBeTruthy();
      });
    },
    STEP_TIMEOUT,
  );

  it.skip("12: the dev lane — introspection dev serves a local MCP into a development task (the CLI serves its login's project; pending a project flag)", () => {});

  it(
    "13: telemetry reads — metrics, a tag, a share, an annotation, events",
    async (ctx) => {
      await steps.run(ctx, "telemetry reads", async () => {
        const now = new Date();
        const metrics = await sa.metrics.query({
          view: "conversations",
          metrics: [{ aggregation: "count" }],
          filters: [{ field: "runtime_id", operator: "eq", value: runtime.id }],
          from_timestamp: new Date(now.getTime() - 3_600_000).toISOString(),
          to_timestamp: new Date(now.getTime() + 60_000).toISOString(),
        } as Parameters<typeof sa.metrics.query>[0]);
        expect(metrics, "a metrics response").toBeTruthy();

        // Access tags are an administrator's to write: the owner's token, not
        // the service account, which acts as the project's agent member.
        const member = new IntrospectionClient({
          token: memberToken,
          advanced: {
            baseApiUrl: settings.baseApiUrl,
            dpUrl: sa.advancedOptions.dpUrl,
          },
        });
        const tag = await member.tags.create({
          kind: "access",
          name: "walk",
          description: "the walk's tag",
        } as Parameters<typeof sa.tags.create>[0]);
        expect(stable(tag)).toMatchInlineSnapshot(`
          {
            "color": null,
            "created_at": "[timestamp]",
            "description": "the walk's tag",
            "kind": "access",
            "name": "walk",
            "updated_at": "[timestamp]",
          }
        `);
        await member.tags.get("access", "walk");
        await member.tags.update("access", "walk", {
          description: "the walk's tag, updated",
        });
        let seenTag = false;
        for await (const item of member.tags.list("access"))
          if (item.name === "walk") seenTag = true;
        expect(seenTag).toBe(true);

        // A tag share's grantor must hold the tag, so the file is shared to
        // the owner member directly.
        const owners = [];
        for await (const m of owner.members.list()) owners.push(m);
        const share = await sa.shares.create({
          resource_type: "file",
          resource_id: outputFile.id,
          granted_member_id: owners[0]!.id,
        } as Parameters<typeof sa.shares.create>[0]);
        expect(stable(share)).toMatchInlineSnapshot(`
          {
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "granted_member_id": "[uuid]",
            "granted_tag": null,
            "id": "[uuid]",
            "org_id": "[uuid]",
            "project_id": "[uuid]",
            "resource_id": "[uuid]",
            "resource_type": "file",
            "updated_at": "[timestamp]",
            "url": "[url]",
            "visible_from": null,
          }
        `);
        await sa.shares.get(share.id);
        let seenShare = false;
        for await (const item of sa.shares.list({ resource_type: "file" }))
          if (item.id === share.id) seenShare = true;
        expect(seenShare).toBe(true);

        const conversation = await sa.conversations.get(conversationId);
        const target = conversation as unknown as {
          trace_id?: string;
          span_id?: string;
        };
        if (target.trace_id && target.span_id) {
          await member.annotations.create(
            { trace_id: target.trace_id, span_id: target.span_id },
            { labels: ["walk"] },
          );
          const annotations = await settled(
            polly!,
            mode,
            async () => {
              const out = [];
              for await (const a of member.annotations.list({
                conversation_id: conversationId,
              } as Parameters<typeof member.annotations.list>[0]))
                out.push(a);
              return out;
            },
            (rows) => rows.length > 0,
            { timeoutMs: 60_000, intervalMs: 3_000, label: "annotations" },
          );
          expect(annotations[0]!.labels).toContain("walk");
          const events = await settled(
            polly!,
            mode,
            async () => {
              const out = [];
              for await (const e of sa.events.list({
                event_name: "introspection.annotation",
                conversation_id: conversationId,
              }))
                out.push(e);
              return out;
            },
            (rows) => rows.length > 0,
            {
              timeoutMs: 60_000,
              intervalMs: 3_000,
              label: "annotation events",
            },
          );
          await sa.events.get((events[0] as { id: string }).id);
        }
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "14: eval — a trial on the runtime, graded by the recipe's judge; an experiment over two versions",
    async (ctx) => {
      await steps.run(ctx, "eval", async () => {
        const cp = raw(sa.cpHttp);
        const judges = await cp.get<Paginated<Judge>>("/v1/judges", {
          project: project.id,
          runtime_group_id: runtime.runtime_group_id,
        });
        judge = judges.records.find((j) => j.name === "greeting")!;
        expect(judge, "the recipe's judge is synced").toBeTruthy();
        const readJudge = await cp.get<Judge>(`/v1/judges/${judge.id}`, {
          project: project.id,
        });
        expect(readJudge.name).toBe("greeting");
        await cp.patch<Judge>(
          `/v1/judges/${judge.id}`,
          { enabled: true, sample_rate: 1 },
          { project: project.id },
        );

        // A trial needs the evals capability, which the runner's session never
        // carries; the service account holds `tasks:eval` and names the runtime.
        const created = await sa.tasks.create({
          kind: "eval",
          runtime_id: runtime.id,
          commands: true,
          prompt: prompt(settings),
          agent_name: settings.agent,
          metadata: { suite: "walk" },
          idle_timeout_seconds: 120,
        } as Parameters<typeof sa.tasks.create>[0]);
        evalTask = created.task;
        expect(stable(evalTask)).toMatchInlineSnapshot(`
          {
            "agent": {
              "sandbox_status": "provisioning",
              "session_id": null,
            },
            "automation_id": null,
            "completed_at": null,
            "conversation_metadata": null,
            "created_at": "[timestamp]",
            "display_index": 5,
            "id": "[uuid]",
            "is_archived": false,
            "kind": "eval",
            "last_user_message_at": "[timestamp]",
            "member_id": "[uuid]",
            "metadata": {
              "active_run_id": "[uuid]",
              "agent_name": "scripted",
              "commands": true,
              "completion_reason": null,
              "conversation_id": "[uuid]",
              "crash_restarts": null,
              "error": null,
              "history_recall": null,
              "idle_timeout_seconds": 120,
              "last_activity_at": null,
              "latest_run_id": "[uuid]",
              "runtime_environment": "production",
              "spawn_resolution": {
                "attribution_env": {
                  "INTROSPECTION_ENVIRONMENT": "production",
                  "INTROSPECTION_JUDGES_OPERATIONAL": "{"greeting":{"enabled":true,"sample_rate":1.0,"judge_id":"01a167eb-d774-7110-bea6-9862a80551ac","definition_hash":"459455f76567d23931987f6e51b8709f8aca44f9c8f665a4d861297113406ba9"}}",
                  "INTROSPECTION_RECIPE_ID": "[uuid]",
                  "INTROSPECTION_RECIPE_KIND": "production",
                  "INTROSPECTION_RECIPE_REF": "main",
                  "INTROSPECTION_RUNTIME_GROUP_ID": "[uuid]",
                  "INTROSPECTION_RUNTIME_ID": "[uuid]",
                  "INTROSPECTION_RUNTIME_KIND": "byor",
                  "INTROSPECTION_RUNTIME_NAME": "hello-mcp",
                  "OTEL_SERVICE_NAME": "hello-mcp",
                },
                "contract": {
                  "agent_name": "scripted",
                  "kind": "pinned_git",
                  "recipe_repo": "[uuid]",
                  "recipe_sha": "[sha]",
                },
                "image_reference": null,
                "recipe_resources": null,
                "recipe_sub_path": ".",
                "runtime_group_id": "[uuid]",
                "runtime_id": "[uuid]",
              },
              "suite": "walk",
              "task_prompt": "Call the \`echo\` tool from the declared \`hello-mcp\` MCP server with the message \`hello from the public MCP\`. Write the echoed value exactly, with no quotes or additional formatting, to \`/workspace/outputs/greeting.txt\`. Then run \`echo $WALK_MARKER\` in the shell and reply in one short sentence.

          <<SCRIPT {"reply":"Echoed the message through hello-mcp and wrote it to the outputs file.","tools":[{"name":"hello-mcp_echo","arguments":{"message":"hello from the public MCP"}},{"name":"write","arguments":{"path":"/workspace/outputs/greeting.txt","content":"Echo: hello from the public MCP"}},{"name":"bash","arguments":{"command":"echo $WALK_MARKER"}}]}>>",
            },
            "org_id": "[uuid]",
            "project_id": "[uuid]",
            "runtime_group_id": "[uuid]",
            "runtime_id": "[uuid]",
            "started_at": null,
            "status": "pending",
            "tags": [],
            "title": "Call the \`echo\` tool from the declared \`hello-mcp\` MCP server with the message \`hello from the public MCP\`. Write the echoed value exactly, with no quotes or additional formatting, to \`/workspace/outputs/greeting.txt\`. Then run \`echo $WALK_MARKER\` in…",
            "updated_at": "[timestamp]",
          }
        `);
        let reply = "";
        for await (const ev of sa.tasks.runs.stream(
          evalTask.id,
          created.run.id,
        )) {
          if (
            (ev as { type: string; delta?: string }).type ===
            "TEXT_MESSAGE_CONTENT"
          )
            reply += (ev as { delta?: string }).delta ?? "";
        }
        expect(reply.length).toBeGreaterThan(0);

        experiment = await sa.experiments.create({
          name: "The walk's experiment",
          project: project.id,
          runtime_group_id: runtime.runtime_group_id,
          goal_json: {
            kind: "composite",
            components: [{ source: "judge", judge_id: judge.id, weight: 1 }],
          },
          arms: [
            { runtime_id: runtime.id, arm_label: "v1" },
            { runtime_id: runtimeV2.id, arm_label: "v2" },
          ],
        });
        expect(stable(experiment)).toMatchInlineSnapshot(`
          {
            "archived_at": null,
            "arms": [
              {
                "agent_overrides": null,
                "arm_label": "v1",
                "id": "[uuid]",
                "initial_weight": 50,
                "runtime_id": "[uuid]",
              },
              {
                "agent_overrides": null,
                "arm_label": "v2",
                "id": "[uuid]",
                "initial_weight": 50,
                "runtime_id": "[uuid]",
              },
            ],
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "description": null,
            "ended_at": null,
            "environment": "production",
            "goal_json": {
              "components": [
                {
                  "guard": null,
                  "judge_definition_hash": "459455f76567d23931987f6e51b8709f8aca44f9c8f665a4d861297113406ba9",
                  "judge_id": "[uuid]",
                  "source": "judge",
                  "weight": 1,
                },
              ],
              "direction": "maximize",
              "kind": "composite",
            },
            "halted_at": null,
            "halted_reason": null,
            "hash_key_fields": [
              "user.id",
              "anonymous.id",
              "conversation.id",
            ],
            "id": "[uuid]",
            "name": "The walk's experiment",
            "org_id": "[uuid]",
            "posterior_json": null,
            "project_id": "[uuid]",
            "routing_strategy": "beta_sample",
            "runtime_group_id": "[uuid]",
            "sample_rate": 1,
            "scoring_interval_seconds": 300,
            "started_at": null,
            "status": "draft",
            "updated_at": "[timestamp]",
            "weights_json": null,
          }
        `);
        await sa.experiments.get(experiment.id);
        await sa.experiments.update(experiment.id, {
          description: "two versions, one judge",
        } as Parameters<typeof sa.experiments.update>[1]);
        const started = await sa.experiments.startById(experiment.id);
        expect(started.status).toBe("running");
        let seen = false;
        for await (const e of sa.experiments.list({ project: project.id }))
          if (e.id === experiment.id) seen = true;
        expect(seen).toBe(true);
        const ended = await sa.experiments.endById(experiment.id);
        expect(stable(ended)).toMatchInlineSnapshot(`
          {
            "archived_at": null,
            "arms": [
              {
                "agent_overrides": null,
                "arm_label": "v1",
                "id": "[uuid]",
                "initial_weight": 50,
                "runtime_id": "[uuid]",
              },
              {
                "agent_overrides": null,
                "arm_label": "v2",
                "id": "[uuid]",
                "initial_weight": 50,
                "runtime_id": "[uuid]",
              },
            ],
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "description": "two versions, one judge",
            "ended_at": "[timestamp]",
            "environment": "production",
            "goal_json": {
              "components": [
                {
                  "guard": null,
                  "judge_definition_hash": "459455f76567d23931987f6e51b8709f8aca44f9c8f665a4d861297113406ba9",
                  "judge_id": "[uuid]",
                  "source": "judge",
                  "weight": 1,
                },
              ],
              "direction": "maximize",
              "kind": "composite",
            },
            "halted_at": null,
            "halted_reason": null,
            "hash_key_fields": [
              "user.id",
              "anonymous.id",
              "conversation.id",
            ],
            "id": "[uuid]",
            "name": "The walk's experiment",
            "org_id": "[uuid]",
            "posterior_json": null,
            "project_id": "[uuid]",
            "routing_strategy": "beta_sample",
            "runtime_group_id": "[uuid]",
            "sample_rate": 1,
            "scoring_interval_seconds": 300,
            "started_at": "[timestamp]",
            "status": "ended",
            "updated_at": "[timestamp]",
            "weights_json": null,
          }
        `);
      });
    },
    BAKE_TIMEOUT,
  );

  it(
    "15: commands — exec and download inside the eval's sandbox",
    async (ctx) => {
      await steps.run(ctx, "commands", async () => {
        const dp = raw(sa.dpHttp);
        const command = async (body: Record<string, unknown>) => {
          const created = await dp.post<TaskCommand>(
            `/v1/tasks/${evalTask.id}/commands`,
            body,
          );
          return settled(
            polly!,
            mode,
            () =>
              dp.get<TaskCommand>(
                `/v1/tasks/${evalTask.id}/commands/${created.id}`,
              ),
            (c) =>
              ["succeeded", "completed", "failed", "cancelled"].includes(
                c.status,
              ),
            { timeoutMs: 120_000, intervalMs: 3_000, label: "task command" },
          );
        };
        const exec = await command({
          kind: "exec",
          command: ["cat", `/workspace/outputs/${WALK.outputFileName}`],
          timeout_seconds: 30,
        });
        expect(stable(exec)).toMatchInlineSnapshot(`
          {
            "created_at": "[timestamp]",
            "error": null,
            "exit_code": 0,
            "finished_at": "[timestamp]",
            "id": "[uuid]",
            "kind": "exec",
            "output_file_id": null,
            "spec": {
              "command": [
                "cat",
                "/workspace/outputs/greeting.txt",
              ],
              "cwd": null,
              "kind": "exec",
              "service": null,
              "timeout_seconds": 30,
            },
            "started_at": "[timestamp]",
            "status": "completed",
            "stderr": "",
            "stdout": "Echo: hello from the public MCP",
            "task_id": "[uuid]",
            "updated_at": "[timestamp]",
          }
        `);
        expect(exec.stdout?.trim()).toBe(WALK.echoResult);
        const download = await command({
          kind: "download",
          path: `/workspace/outputs/${WALK.outputFileName}`,
        });
        expect(
          download.output_file_id,
          "the download produced a file",
        ).toBeTruthy();
        const listed = await dp.get<Paginated<TaskCommand>>(
          `/v1/tasks/${evalTask.id}/commands`,
        );
        expect(listed.records.length).toBeGreaterThanOrEqual(2);

        // Judging runs in the sandbox at teardown and calls the judge's own
        // grader model through the egress. On the scripted target that grader
        // is the model double, which returns no verdict, so a judgement is
        // asserted only where a real model grades (design doc §10).
        const judgements = await settled(
          polly!,
          mode,
          async () => {
            const out = [];
            for await (const e of sa.events.list({
              event_name: "introspection.judgement",
              judge_id: judge.id,
            } as Parameters<typeof sa.events.list>[0]))
              out.push(e);
            return out;
          },
          (rows) => rows.length > 0 || settings.agent === "scripted",
          { timeoutMs: BAKE_TIMEOUT, intervalMs: 10_000, label: "judgement" },
        );
        if (settings.agent !== "scripted") {
          expect(judgements.length, "the recipe's judge graded the trial").toBeGreaterThan(0);
        }
      });
    },
    BAKE_TIMEOUT,
  );

  it(
    "16: automations — a manual automation, triggered",
    async (ctx) => {
      await steps.run(ctx, "automations", async () => {
        automation = await sa.automations.create({
          name: "The walk's automation",
          trigger_type: "manual",
          prompt: secondTurn(settings),
          runtime_group_id: runtime.runtime_group_id,
          // An automation its owner creates posts into that owner's own task;
          // the first task was archived and unarchived, which the trigger
          // still refuses, so the trial is the one it posts into.
          task_id: evalTask.id,
        } as Parameters<typeof sa.automations.create>[0]);
        expect(stable(automation)).toMatchInlineSnapshot(`
          {
            "can_manage": true,
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "cron_schedule": null,
            "description": null,
            "enabled": true,
            "execution_blocked_reason": null,
            "id": "[uuid]",
            "kind": null,
            "last_triggered_at": null,
            "metadata": null,
            "name": "The walk's automation",
            "next_trigger_at": null,
            "org_id": "[uuid]",
            "owner_role": "operator",
            "project_id": "[uuid]",
            "prompt": "Reply with the single word done. <<SCRIPT {"reply":"done"}>>",
            "runtime_group_id": "[uuid]",
            "tags": [],
            "task_id": "[uuid]",
            "trigger_type": "manual",
            "updated_at": "[timestamp]",
          }
        `);
        const triggered = await sa.automations.trigger(automation.id);
        expect(stable(triggered)).toMatchInlineSnapshot(`
          {
            "automation_id": "[uuid]",
            "reason": null,
            "status": "triggered",
            "task_id": "[uuid]",
          }
        `);
        await sa.automations.get(automation.id);
        await sa.automations.update(automation.id, {
          description: "triggered once by the walk",
        } as Parameters<typeof sa.automations.update>[1]);
        let seen = false;
        for await (const a of sa.automations.list())
          if (a.id === automation.id) seen = true;
        expect(seen).toBe(true);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "17: members and keys — the owner's reads, a development API key, the organisation",
    async (ctx) => {
      await steps.run(ctx, "members and keys", async () => {
        const members = [];
        for await (const m of owner.members.list()) members.push(m);
        expect(members.length).toBeGreaterThan(0);
        await owner.members.get(members[0]!.id);
        const cp = raw(sa.cpHttp);
        apiKey = await cp.post<ApiKey>(
          "/v1/api-keys",
          { name: "walk", environment: "development", allow: ["runtimes"] },
          { project: project.id },
        );
        expect(
          apiKey.api_key,
          "the plaintext key is returned once",
        ).toBeTruthy();
        expect(
          stable({ ...apiKey, api_key: undefined }),
        ).toMatchInlineSnapshot(`
          {
            "acknowledged_at": null,
            "allow": [
              "runtimes",
            ],
            "api_key": undefined,
            "created_at": "[timestamp]",
            "environment": "development",
            "expires_at": null,
            "id": "[uuid]",
            "key_display": "intro_dev_9ffdS_O7...xk2k",
            "key_prefix": "intro_dev_9ffdS_O7",
            "key_suffix": "xk2k",
            "last_used_at": null,
            "member_id": "[uuid]",
            "name": "walk",
            "org_id": "[uuid]",
            "prefix": "intro_dev_9ffdS_O7",
            "project_id": "[uuid]",
            "redacted_key": "[redacted]",
            "scope": "telemetry:write projects:read repositories:read recipes:read recipes:write runtimes:read runtimes:write experiments:read experiments:write tasks:read tasks:write tasks:delete files:read files:write conversations:read events:read metrics:read shares:read shares:write shares:delete connectors:read connectors:write annotations:read approvals:read approvals:write",
            "status": "active",
          }
        `);
        // The key list is its own envelope, `api_keys`, not a page.
        const keys = await cp.get<{ api_keys: ApiKey[] }>("/v1/api-keys", {
          project: project.id,
        });
        expect(keys.api_keys.some((k) => k.id === apiKey.id)).toBe(true);
        await cp.patch<ApiKey>(
          `/v1/api-keys/${apiKey.id}`,
          { name: "walk (renamed)" },
          { project: project.id },
        );
        await cp.post(
          `/v1/api-keys/${apiKey.id}/acknowledge`,
          {},
          { project: project.id },
        );
        const org = await raw(owner.cpHttp).get<{ id: string; slug: string }>(
          "/v1/organizations/me",
        );
        expect(stable(org)).toMatchInlineSnapshot(`
          {
            "external_org_id": "395163796525572367",
            "hosted_git": true,
            "id": "[uuid]",
            "image_url": null,
            "name": "Introspection.dev",
            "slug": "introspectiondev",
          }
        `);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "18: teardown — everything the walk created, in reverse",
    async (ctx) => {
      await steps.run(ctx, "teardown", async () => {
        // Deleting is the owner's: the `:delete` scopes of runtimes, recipes,
        // experiments, repositories and connectors are never minted to an
        // application, so the session does what the service account cannot.
        const cp = raw(owner.cpHttp);
        const dp = raw(sa.dpHttp);
        const q = { project: project.id };
        await cp.delete(`/v1/api-keys/${apiKey.id}`, q);
        await sa.automations.delete(automation.id);
        // The runner's session never carries `tasks:delete`; the service account does.
        for await (const t of sa.tasks.list()) await sa.tasks.delete(t.id);
        await expectNotFound(() => sa.tasks.get(task.id));
        // The default list omits the upload a task holds, so it goes by id.
        await sa.files.delete(inputFile.id);
        for await (const f of sa.files.list({}))
          await sa.files.delete(f.id).catch(() => undefined);
        await expectNotFound(() => sa.files.get(inputFile.id));
        // `experiments:delete` is no scope a token can name, so the owner deletes.
        await owner.experiments.delete(experiment.id, project.id);
        // Every version in the group: the push's, the walk's and the arm's.
        for await (const r of sa.runtimes.list({ project: project.id, runtime: WALK.runtimeSlug })) {
          await cp.delete(`/v1/runtimes/${r.id}`, q);
        }
        await expectNotFound(() => sa.runtimes.get(runtimeV2.id));
        // The group's endpoint binding went with its last runtime version.
        await cp.delete(`/v1/endpoints/${endpoint.id}`, q).catch((err: unknown) => {
          if (!(err instanceof NotFoundError)) throw err;
        });
        for await (const c of sa.connectors.connections.list(connector.id)) {
          await cp.delete(`/v1/connectors/${connector.id}/connections/${c.id}`, q);
        }
        await cp.delete(`/v1/connectors/${connector.id}`, q);
        await expectNotFound(() => sa.connectors.get(connector.id));
        const variables = await cp.get<Paginated<Variable>>("/v1/variables", q);
        for (const v of variables.records)
          await cp.delete(`/v1/variables/${v.id}`, q);
        const credentials = await cp.get<Paginated<Credential>>(
          "/v1/credentials",
          q,
        );
        for (const c of credentials.records)
          await cp.delete(`/v1/credentials/${c.id}`, q);
        for await (const r of sa.recipes.list({ project: project.id })) {
          await cp.delete(`/v1/recipes/${r.id}`, q);
        }
        await expectNotFound(() => sa.recipes.get(recipe.id));
        await cp.delete(`/v1/repositories/${repository.id}`, q);
        await dp
          .get(`/v1/repositories/${repository.id}/branches`)
          .catch(() => undefined);
        await cp.delete(`/v1/applications/${application.id}`, q);
        await raw(owner.cpHttp).delete(`/v1/projects/${project.id}`);
        await expectNotFound(() =>
          raw(owner.cpHttp).get<Project>(`/v1/projects/${project.id}`),
        );
      });
    },
    STEP_TIMEOUT,
  );
});

async function expectNotFound(read: () => Promise<unknown>): Promise<void> {
  const outcome = await read().then(
    () => "found",
    (err: unknown) => (err instanceof NotFoundError ? "not found" : err),
  );
  expect(outcome).toBe("not found");
}
