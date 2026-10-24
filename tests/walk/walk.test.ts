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
  ValidationError,
  serviceAccountToken,
  type Runner,
} from "@introspection-sdk/introspection-node";
import type {
  ApiKeyCreated,
  Application,
  Automation,
  Connector,
  Endpoint,
  Experiment,
  Judge,
  Project,
  File as IntrospectionFile,
  Recipe,
  Repository,
  Runtime,
  Task,
  TaskCommand,
  TaskCommandSpec,
} from "@introspection-sdk/types";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPollyMode, setupPolly } from "../polly-setup";
import {
  BOOTSTRAP_FILE,
  followAuthorization,
  hasCompleteRecording,
  prompt,
  prepareRecipe,
  pushBranch,
  pushRecipe,
  secondTurn,
  raw,
  NATIVE_FETCH,
  settled,
  spanEventId,
  stable,
  Steps,
  ownOrStale,
  retargetRecipe,
  walkNames,
  walkSettings,
  type WalkNames,
  type WalkSettings,
} from "./support";

const RECORDING = "walk";
/** This run's names (`walkNames`), set once the settings name the run. */
let WALK: WalkNames;
const STEP_TIMEOUT = 10 * 60_000;
const BAKE_TIMEOUT = 30 * 60_000;
// Beside the HAR, wherever Polly writes it (POLLY_RECORDINGS_DIR redirects both).
const RECORDINGS_DIR =
  process.env.POLLY_RECORDINGS_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../recordings");
const recordingDir = `${RECORDINGS_DIR}/${RECORDING}`;
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
  "approvals:read",
  "approvals:write",
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
  /** The same credentials on the native fetch: polls that the recording never sees. */
  let saQuiet: IntrospectionClient;
  let project: Project;
  let application: Application;
  let repository: Repository;
  let memberToken: string;
  let hostedUrl: string;
  let member: IntrospectionClient;
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
  let apiKey: ApiKeyCreated;
  let shareId: string;
  let recipeDir: string;

  beforeAll(() => {
    polly = setupPolly({ recordingName: RECORDING, ordered: true });
    settings = walkSettings(mode);
    WALK = walkNames(settings.run);
    if (mode !== "replay") {
      recipeDir = prepareRecipe(
        { url: settings.recipeRepositoryUrl, ref: settings.recipeGitRef },
        settings.agent,
      );
      retargetRecipe(recipeDir, WALK.recipeSlug);
    }
    owner = new IntrospectionClient({
      cpSession: settings.cpSession,
      advanced: { baseApiUrl: settings.baseApiUrl },
    });
  }, STEP_TIMEOUT);

  afterAll(async () => {
    if (recipeDir) fs.rmSync(recipeDir, { recursive: true, force: true });
    await polly?.stop();
  }, STEP_TIMEOUT);

  it(
    "0: the login's project, with what a crashed run left removed",
    async (ctx) => {
      await steps.run(ctx, "clean slate", async () => {
        // The walk runs in the login's project, under names that carry this
        // run's suffix (`walkNames`), so two runs share the project without
        // meeting. A record run writes the project id and the run beside the
        // recording, which is all replay needs to send the same calls.
        project = await owner.projects.get(settings.bootstrapProjectId!);
        if (mode === "record") {
          fs.mkdirSync(recordingDir, { recursive: true });
          fs.writeFileSync(
            `${recordingDir}/${BOOTSTRAP_FILE}`,
            JSON.stringify({ project_id: project.id, run: settings.run }) +
              "\n",
          );
        }
        // The owner's Data Plane token for the project: it carries
        // `git:push`, which no service account can, and the member-only
        // Data Plane writes (access tags, annotations).
        const minted = await raw(owner.cpHttp).post<{
          access_token: string;
          project_id: string;
        }>("/v1/tokens", { project: project.id, expires_hours: 24 });
        memberToken = minted.access_token;
        expect(minted.project_id).toBe(project.id);
        member = new IntrospectionClient({
          token: memberToken,
          advanced: {
            baseApiUrl: settings.baseApiUrl,
            dpUrl: settings.dpUrl ?? undefined,
          },
        });
        // A run that crashed before its teardown left resources under its own
        // suffix; those older than the cutoff go now, never a run still going.
        const take = ownOrStale(settings.run);
        await removeWalkResources(
          owner,
          member,
          project,
          member,
          (name) => take(name) && !name?.includes(settings.run),
        );
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "1: project — read, list, update; a sibling created and deleted",
    async (ctx) => {
      await steps.run(ctx, "project", async () => {
        // The slug is new on every live run, so the snapshot leaves it out.
        expect(
          stable({
            ...project,
            name: undefined,
            slug: undefined,
            description: undefined,
          }),
        ).toMatchInlineSnapshot(`
          {
            "created_by_member_id": "[uuid]",
            "deployment_id": "[uuid]",
            "description": undefined,
            "id": "[uuid]",
            "name": undefined,
            "org_id": "[uuid]",
            "settings": null,
            "slug": undefined,
          }
        `);
        const read = await owner.projects.get(project.id);
        expect(read.id).toBe(project.id);

        const listed = await owner.projects.list();
        expect(listed.records.some((p) => p.id === project.id)).toBe(true);

        // The writes go to a sibling of this run's own, never the login's
        // project another run may be reading.
        const sibling = await owner.projects.create({
          name: `${project.name} (walk ${WALK.run})`,
          slug: `${project.slug}${WALK.siblingSuffix}-${WALK.run}`,
          deployment_id: project.deployment_id,
        });
        const updated = await owner.projects.update(sibling.id, {
          description: "The SDK end-to-end walk ran here",
        });
        expect(updated.description).toBe("The SDK end-to-end walk ran here");
        expect(sibling.deployment_id).toBe(project.deployment_id);
        expect(stable({ ...sibling, name: undefined, slug: undefined }))
          .toMatchInlineSnapshot(`
          {
            "created_by_member_id": "[uuid]",
            "deployment_id": "[uuid]",
            "description": null,
            "id": "[uuid]",
            "name": undefined,
            "org_id": "[uuid]",
            "settings": null,
            "slug": undefined,
          }
        `);
        await owner.projects.delete(sibling.id);
        await expectNotFound(() => owner.projects.get(sibling.id));
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "2: application — a service account, its secret, and the token that names the Data Plane",
    async (ctx) => {
      await steps.run(ctx, "application", async () => {
        application = await owner.applications.create(
          {
            name: WALK.applicationName,
            application_type: "service_account",
            allowed_scopes: APPLICATION_SCOPES,
          },
          project.id,
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
              "approvals:read",
              "approvals:write",
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
            "name": "sdk-coverage-walk-[run]",
            "org_id": "[uuid]",
            "project_id": "[uuid]",
            "redirect_uris": [],
            "revoked_at": null,
            "updated_at": "[timestamp]",
          }
        `);

        const first = await owner.applications.secrets.create(application.id, {
          name: "first",
        });
        expect(first.secret, "the plaintext is returned once").toBeTruthy();

        const minted = await serviceAccountToken({
          clientId: application.client_id,
          clientSecret: first.secret!,
          project: project.id,
          baseApiUrl: settings.baseApiUrl,
        });
        expect(
          minted.dp_url,
          "the token response names the Data Plane",
        ).toBeTruthy();
        const credentials = {
          token: minted.access_token,
          advanced: {
            baseApiUrl: settings.baseApiUrl,
            dpUrl: minted.dp_url ?? undefined,
          },
        };
        sa = new IntrospectionClient(credentials);
        saQuiet = new IntrospectionClient({
          ...credentials,
          advanced: { ...credentials.advanced, fetch: NATIVE_FETCH },
        });

        const listed = await owner.applications.list({ project: project.id });
        expect(listed.records.some((a) => a.id === application.id)).toBe(true);
        const read = await owner.applications.get(application.id, project.id);
        expect(read.client_id).toBe(application.client_id);
        const renamed = await owner.applications.update(
          application.id,
          { name: `${WALK.applicationName}-renamed` },
          project.id,
        );
        expect(renamed.name).toBe(`${WALK.applicationName}-renamed`);

        // Rotate: a second secret, then the first revoked.
        const second = await owner.applications.secrets.create(application.id, {
          name: "second",
        });
        const secrets = await owner.applications.secrets.list(application.id);
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
                "secret_prefix": "[redacted]",
                "secret_suffix": "[redacted]",
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
                "secret_prefix": "[redacted]",
                "secret_suffix": "[redacted]",
                "status": "active",
                "updated_at": "[timestamp]",
              },
            ]
          `);
        await owner.applications.secrets.delete(application.id, first.id);
        expect(second.id).not.toBe(first.id);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "3: repository — a hosted repository the walk pushes the recipe into",
    async (ctx) => {
      await steps.run(ctx, "repository", async () => {
        // `POST /v1/repositories` is documented for the CLI only, so this
        // is the one write the walk sends by hand.
        const created = await raw(sa.cpHttp).post<Repository>(
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
            "name": "hello-mcp-[run]",
            "project_id": "[uuid]",
            "provider": "introspection",
            "provisioning_status": "pending",
            "pushed_at": null,
            "seed_template": "pi-agent",
            "slug": "hello-mcp-[run]",
            "url": "[url]",
          }
        `);

        // Provisioning seeds the hosted copy with the deployment's template and
        // reports it; that first push pins a recipe. A runtime made from it
        // registers the group's slug, which is what lets the next push
        // version the group and sync its judges (hosted-recipe-git.md).
        repository = await settled(
          mode,
          () => sa.repositories.get(created.id, { project: project.id }),
          () => saQuiet.repositories.get(created.id, { project: project.id }),
          (r) =>
            r.provisioning_status === "ready" ||
            r.provisioning_status === "failed",
          { timeoutMs: 180_000, intervalMs: 2_000, label: "hosted repository" },
        );
        expect(repository.provisioning_status).toBe("ready");
        const seeded = await settled(
          mode,
          async () => {
            const out: Recipe[] = [];
            for await (const r of sa.recipes.list({ project: project.id }))
              out.push(r);
            return out;
          },
          async () => {
            const out: Recipe[] = [];
            for await (const r of saQuiet.recipes.list({ project: project.id }))
              out.push(r);
            return out;
          },
          (rows) => rows.some((r) => r.repository_id === repository.id),
          { timeoutMs: 180_000, intervalMs: 3_000, label: "seed recipe" },
        );
        const seedRecipe = seeded.find(
          (r) => r.repository_id === repository.id,
        )!;
        const seedRuntime = await sa.runtimes.create({
          project: project.id,
          recipe_id: seedRecipe.id,
          name: WALK.runtimeSlug,
          slug: WALK.runtimeSlug,
        });
        expect(seedRuntime.slug).toBe(WALK.runtimeSlug);

        hostedUrl = created.url!;
        if (mode !== "replay") {
          pushRecipe(recipeDir, { url: hostedUrl, bearer: memberToken });
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
        const page = await sa.repositories.commits(repository.id, {
          sha: "main",
        });
        const head = page.records[0];
        expect(head?.sha, "a commit on the hosted main").toBeTruthy();
        const detail = await sa.repositories.commit(repository.id, head!.sha);
        expect(detail.sha).toBe(head!.sha);
        const branches = await sa.repositories.branches(repository.id);
        expect(branches.records.some((b) => b.name === "main")).toBe(true);
        const entry = await sa.repositories.contents.get(
          repository.id,
          "agents/scripted.yaml",
          { ref: head!.sha },
        );
        expect(entry.path).toBe("agents/scripted.yaml");
        const root = await sa.repositories.contents(repository.id, {
          ref: head!.sha,
        });
        expect(root.records.some((e) => e.path === "judges")).toBe(true);

        // The push versioned the manifest's recipe at the pushed commit; the
        // create below names the same pin and answers with that row.
        const versioned = await settled(
          mode,
          async () => {
            const out: Recipe[] = [];
            for await (const r of sa.recipes.list({ project: project.id }))
              out.push(r);
            return out.find((r) => r.git_commit_sha === head!.sha) ?? null;
          },
          async () => {
            const out: Recipe[] = [];
            for await (const r of saQuiet.recipes.list({ project: project.id }))
              out.push(r);
            return out.find((r) => r.git_commit_sha === head!.sha) ?? null;
          },
          (r) => r !== null,
          {
            timeoutMs: 180_000,
            intervalMs: 3_000,
            label: "push-versioned recipe",
          },
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
            "name": "hello-mcp-[run]",
            "org_id": "[uuid]",
            "policies": null,
            "project_id": "[uuid]",
            "repository_id": "[uuid]",
            "slug": "hello-mcp-[run]-production-main-[sha]",
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
        pinnedRecipe = await sa.recipes.create({
          project: project.id,
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
        const updated = await sa.recipes.update(recipe.id, {
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
        const credential = await sa.credentials.create(
          { name: WALK.credentialName, secret: WALK.credentialSecret },
          project.id,
        );
        expect("secret" in credential, "a secret never reads back").toBe(false);
        expect(stable(credential)).toMatchInlineSnapshot(`
          {
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "environment": null,
            "has_secret": true,
            "id": "[uuid]",
            "name": "WALK_SECRET_[run]",
            "org_id": "[uuid]",
            "project_id": "[uuid]",
            "runtime_group_id": null,
            "runtime_id": null,
            "secret_display": "walk***0001",
            "secret_set_at": "[timestamp]",
            "updated_at": "[timestamp]",
          }
        `);
        const credentials = await sa.credentials.list({ project: project.id });
        expect(credentials.records.some((c) => c.id === credential.id)).toBe(
          true,
        );
        const readCredential = await sa.credentials.get(
          credential.id,
          project.id,
        );
        expect(readCredential.name).toBe(WALK.credentialName);
        await sa.credentials.update(
          credential.id,
          { secret: `${WALK.credentialSecret}-rotated` },
          project.id,
        );

        const variable = await sa.variables.create(
          { name: WALK.variableName, kind: "value", value: WALK.variableValue },
          project.id,
        );
        expect(stable(variable)).toMatchInlineSnapshot(`
          {
            "created_at": "[timestamp]",
            "created_by_member_id": "[uuid]",
            "environment": null,
            "id": "[uuid]",
            "kind": "value",
            "name": "WALK_MARKER_[run]",
            "org_id": "[uuid]",
            "project_id": "[uuid]",
            "runtime_group_id": null,
            "runtime_id": null,
            "updated_at": "[timestamp]",
            "value": "walk-marker-7f3a",
          }
        `);
        const variables = await sa.variables.list({ project: project.id });
        expect(variables.records.some((v) => v.id === variable.id)).toBe(true);
        const updated = await sa.variables.update(
          variable.id,
          { value: WALK.variableValue },
          project.id,
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
        // Create is idempotent on the slug, and the login's project keeps the
        // connector between runs: pending when new, active once granted.
        const { status, ...created } = connector;
        expect(["pending", "active"]).toContain(status);
        expect(stable(created)).toMatchInlineSnapshot(`
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
        // Only an aggregator connector (Pipedream) has an app catalogue; an
        // MCP server's is refused. The open MCP registry is what a custom
        // connector is picked from.
        await expect(
          sa.connectors.listApps(connector.id, { limit: 5 }),
        ).rejects.toBeInstanceOf(ValidationError);
        const registry = await sa.connectors.searchCustomApps({
          q: "echo",
          limit: 5,
        });
        expect(Array.isArray(registry)).toBe(true);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "7: runtime — created from the recipe and baked",
    async (ctx) => {
      await steps.run(ctx, "runtime", async () => {
        // The push versioned the group at the recipe's commit; that version
        // is the runtime the walk runs on, and the API creates the next one.
        const versioned = await settled(
          mode,
          async () => {
            const out: Runtime[] = [];
            for await (const r of sa.runtimes.list({
              project: project.id,
              runtime: WALK.runtimeSlug,
            })) {
              out.push(r);
            }
            return out.find((r) => r.recipe_id === recipe.id) ?? null;
          },
          async () => {
            const out: Runtime[] = [];
            for await (const r of saQuiet.runtimes.list({
              project: project.id,
              runtime: WALK.runtimeSlug,
            })) {
              out.push(r);
            }
            return out.find((r) => r.recipe_id === recipe.id) ?? null;
          },
          (r) =>
            r !== null &&
            (r.image_build_status === "ready" ||
              r.image_build_status === "failed"),
          {
            timeoutMs: BAKE_TIMEOUT,
            intervalMs: 10_000,
            label: "push-versioned runtime bake",
          },
        );
        runtime = versioned!;
        expect(
          runtime.image_build_status,
          runtime.image_build_error_message ?? "",
        ).toBe("ready");
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
              "external_image_name": "[redacted]",
              "image_tag": "[redacted]",
              "size_bytes": "[number]",
              "verdict_by": "[timestamp]",
            },
            "image_build_status": "ready",
            "kind": "byor",
            "llm_mode": "managed",
            "name": "hello-mcp-[run]",
            "org_id": "[uuid]",
            "project_id": "[uuid]",
            "recipe_id": "[uuid]",
            "recipe_kind": "production",
            "recipe_ref": "main",
            "runtime_group_id": "[uuid]",
            "slug": "hello-mcp-[run]",
            "updated_at": "[timestamp]",
            "yanked_at": null,
            "yanked_reason": null,
          }
        `);

        // A version's identity in its group is its recipe, so the next
        // version pins the walk's own recipe of the same commit.
        const created = await sa.runtimes.create({
          project: project.id,
          recipe_id: pinnedRecipe.id,
          name: WALK.runtimeSlug,
          slug: WALK.runtimeSlug,
          config_json: { connectors: [WALK.connectorName] },
        });
        expect(created.runtime_group_id).toBe(runtime.runtime_group_id);
        runtimeV2 = await settled(
          mode,
          () => sa.runtimes.get(created.id),
          () => saQuiet.runtimes.get(created.id),
          (r) =>
            r.image_build_status === "ready" ||
            r.image_build_status === "failed",
          {
            timeoutMs: BAKE_TIMEOUT,
            intervalMs: 10_000,
            label: "runtime bake",
          },
        );
        expect(
          runtimeV2.image_build_status,
          runtimeV2.image_build_error_message ?? "",
        ).toBe("ready");
        const described = await sa.runtimes.update(runtimeV2.id, {
          description: "the walk's own version",
        });
        expect(described.description).toBe("the walk's own version");
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

        // Another run's runtime may have a `hello-mcp` endpoint too.
        const endpoints = await sa.endpoints.list({
          project: project.id,
          mcp_server_id: WALK.mcpServerId,
        });
        endpoint = endpoints.records.find(
          (e) => e.runtime_group_id === runtime.runtime_group_id,
        )!;
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
        const read = await sa.endpoints.get(endpoint.id, project.id);
        expect(read.kind).toBe("mcp");
        const renamed = await sa.endpoints.update(
          endpoint.id,
          { name: "hello-mcp (walk)" },
          project.id,
        );
        expect(renamed.name).toBe("hello-mcp (walk)");

        const token = await sa.connectors.connections.getToken(connector.id, {
          runtime: runtime.runtime_group_id,
        } as Parameters<typeof sa.connectors.connections.getToken>[1]);
        expect(stable(token)).toMatchInlineSnapshot(`
          {
            "expires_at": "[timestamp]",
            "scopes": [],
            "token": "[redacted]",
            "token_type": "bearer",
          }
        `);

        const requirements = await sa.runtimes.get(runtime.id, {
          include: "mcp_requirements",
        });
        expect(stable(requirements.mcp_requirements)).toMatchInlineSnapshot(
          `[]`,
        );

        // Registered mode: a connection from a token the caller already holds,
        // for one user beside the app's own grant; read, then revoked.
        const registered = await sa.connectors.connections.create(
          connector.id,
          { access_token: "walk-registered-token", subject_type: "user" },
        );
        const reread = await sa.connectors.connections.get(
          connector.id,
          registered.id,
        );
        expect(reread.subject_type).toBe("user");
        // Revoking takes `connectors:delete`, which no application is minted;
        // the owner revokes, as the teardown does.
        await owner.connectors.connections.revoke(
          connector.id,
          registered.id,
          project.id,
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
          metadata: { suite: "walk", walk_run: WALK.run },
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
              "blob_checksum": "[digest]",
              "original_filename": "walk-input-[run].txt",
              "suite": "walk",
              "walk_run": "[run]",
            },
            "mime_type": "text/plain",
            "name": "walk-input-[run].txt",
            "org_id": "[uuid]",
            "parent_id": null,
            "project_id": "[uuid]",
            "size_bytes": "[number]",
            "storage_path": "[uuid]/[uuid]/files/[uuid]/walk-input-[run].txt",
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
          metadata: { suite: "walk", walk_run: WALK.run, stage: "attached" },
        });
        expect(updated.metadata?.stage).toBe("attached");
        const tagged: string[] = [];
        // A file with versions is listed only with `include_versions`.
        for await (const f of sa.files.list({
          metadata: { suite: "walk", walk_run: WALK.run, stage: "attached" },
          include_versions: true,
        })) {
          tagged.push(f.id);
        }
        expect(tagged, "the metadata filter finds the file").toContain(
          inputFile.id,
        );
        await sa.files.update(inputFile.id, { tags: ["suite:walk"] });
        const byTag: string[] = [];
        for await (const f of sa.files.list({
          tag: "suite:walk",
          include_versions: true,
        })) {
          byTag.push(f.id);
        }
        expect(byTag, "the tag filter finds the file").toContain(inputFile.id);
        const byName: string[] = [];
        for await (const f of sa.files.list({
          name_contains: "WALK-INPUT",
          include_versions: true,
        })) {
          byName.push(f.id);
        }
        expect(byName, "the substring filter finds the file").toContain(
          inputFile.id,
        );
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
          metadata: { suite: "walk", walk_run: WALK.run },
          idle_timeout_seconds: 180,
        } as Parameters<typeof runner.tasks.start>[0]);
        expect(started.task, "the create returns the task").toBeTruthy();
        const reply = await started.text();
        expect(reply.length, "the turn replied").toBeGreaterThan(0);

        // The stream ends before the row settles; the second turn needs it idle.
        task = await settled(
          mode,
          () => runner.tasks.get(started.task!.id),
          () => saQuiet.tasks.get(started.task!.id),
          (t) => ["idle", "awaiting_user", "completed"].includes(t.status),
          {
            timeoutMs: 120_000,
            intervalMs: 2_000,
            label: "task after its first turn",
          },
        );
        // `metadata` is the platform's (the launch path, the active run) and
        // differs between a warm pod and a baked image; the walk's own key is
        // asserted and the rest left out of the snapshot.
        expect(task.metadata?.suite).toBe("walk");
        expect(stable({ ...task, metadata: undefined })).toMatchInlineSnapshot(`
          {
            "agent": null,
            "automation_id": null,
            "completed_at": null,
            "conversation_metadata": null,
            "created_at": "[timestamp]",
            "display_index": "[number]",
            "id": "[uuid]",
            "is_archived": false,
            "kind": "agent",
            "last_user_message_at": "[timestamp]",
            "member_id": "[uuid]",
            "metadata": undefined,
            "org_id": "[uuid]",
            "project_id": "[uuid]",
            "runtime_group_id": "[uuid]",
            "runtime_id": "[uuid]",
            "started_at": "[timestamp]",
            "status": "idle",
            "tags": [],
            "title": "Call the \`echo\` tool from the declared \`hello-mcp\` MCP server with the message \`hello from the public MCP\`. Write the echoed value exactly, with no quotes or additional formatting, to \`/workspace/outputs/greeting.txt\`. Then run \`echo…",
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
          mode,
          () => runner.tasks.get(task.id),
          () => saQuiet.tasks.get(task.id),
          (t) => ["idle", "awaiting_user", "completed"].includes(t.status),
          {
            timeoutMs: 120_000,
            intervalMs: 2_000,
            label: "task after its second turn",
          },
        );

        const third = await runner.tasks.runs.create(task.id, {
          prompt: { text: secondTurn(settings) },
        });
        await third.cancel();
        await settled(
          mode,
          () => runner.tasks.get(task.id),
          () => saQuiet.tasks.get(task.id),
          (t) =>
            ["idle", "awaiting_user", "completed", "cancelled"].includes(
              t.status,
            ),
          {
            timeoutMs: 120_000,
            intervalMs: 2_000,
            label: "task after a cancelled turn",
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
          mode,
          async () => {
            const out: IntrospectionFile[] = [];
            for await (const f of sa.files.list({ task_id: task.id }))
              out.push(f);
            return out;
          },
          async () => {
            const out: IntrospectionFile[] = [];
            for await (const f of saQuiet.files.list({ task_id: task.id }))
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
              "blob_checksum": "[digest]",
              "conversation_id": "[uuid]",
              "original_filename": "greeting.txt",
              "relative_path": "greeting.txt",
              "task_id": "[uuid]",
            },
            "mime_type": "text/plain",
            "name": "tasks/[uuid]/outputs/greeting.txt",
            "org_id": "[uuid]",
            "parent_id": null,
            "project_id": "[uuid]",
            "size_bytes": "[number]",
            "storage_path": "[uuid]/[uuid]/files/[uuid]/greeting.txt",
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
          mode,
          () => sa.conversations.get(conversationId),
          () => saQuiet.conversations.get(conversationId),
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
              "duration_ms": "[number]",
              "failed_llm_call_count": "[number]",
              "failed_tool_use_count": "[number]",
              "has_errors": false,
              "llm_call_count": "[number]",
              "max_turn": "[number]",
              "span_count": "[number]",
              "tool_use_count": "[number]",
              "trace_count": "[number]",
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
            "service_name": "hello-mcp-[run]",
            "task_title": "The walk's task",
            "updated_at": "[timestamp]",
            "usage": {
              "output_tokens": "[number]",
              "total_input_tokens": "[number]",
              "total_tokens": "[number]",
            },
          }
        `);
        expect(conversation.metrics.llm_call_count).toBeGreaterThan(0);
        expect(conversation.metrics.tool_use_count).toBeGreaterThan(0);
        expect(conversation.metrics.trace_count).toBeGreaterThanOrEqual(2);
        expect(conversation.usage.total_tokens).toBeGreaterThan(0);
        const page = await settled(
          mode,
          async () => await sa.conversations.items.list(conversationId),
          async () => await saQuiet.conversations.items.list(conversationId),
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

        // The other export formats, the Arrow list, and a paged item list.
        const latest = await sa.conversations.retrieve(conversationId);
        expect(latest?.span_id, "the latest LLM turn").toBeTruthy();
        const exported = await sa.conversations.exportJson(conversationId);
        expect(exported.data.length).toBeGreaterThanOrEqual(page.data.length);
        const exportedTable =
          await sa.conversations.exportArrow(conversationId);
        // Spans can still be arriving between two exports, so each is held
        // to the items the step already read rather than to the other.
        expect(exportedTable.numRows).toBeGreaterThanOrEqual(page.data.length);
        const stream = await sa.conversations.exportStream(
          conversationId,
          "json",
        );
        const streamed = JSON.parse(await new Response(stream).text()) as {
          data: unknown[];
        };
        expect(streamed.data.length).toBeGreaterThanOrEqual(page.data.length);
        const listedTable = await sa.conversations
          .listArrow({ runtime_group_id: runtime.runtime_group_id })
          .readAll();
        expect(listedTable.numRows).toBeGreaterThan(0);
        let itemPages = 0;
        for await (const _ of sa.conversations.items.list(conversationId, {
          limit: 1,
        })) {
          if (++itemPages === 2) break;
        }
        expect(itemPages, "a second page of items").toBe(2);
        // `contains` selects items by the plaintext summary of their messages.
        const toolCalls = await sa.conversations.items.list(conversationId, {
          contains: ["gen_ai.output.messages.parts.name:*"],
        });
        expect(JSON.stringify(toolCalls), "a tool-call item").toContain("echo");
        const userTurns = await sa.conversations.items.list(conversationId, {
          contains: ["gen_ai.input.messages.role:user"],
        });
        expect(userTurns.data.length, "a user turn").toBeGreaterThan(0);
      });
    },
    STEP_TIMEOUT,
  );

  it.skip("12: the dev lane — introspection dev serves a local MCP into a development task (the CLI serves its login's project; pending a project flag)", () => {});

  it(
    "13: telemetry reads — metrics, a tag, a share, an annotation, events",
    async (ctx) => {
      await steps.run(ctx, "telemetry reads", async () => {
        // A fixed window, so the request replays; the walk's conversation is
        // within it by construction.
        const metrics = await sa.metrics.query({
          view: "conversations",
          metrics: [{ aggregation: "count" }],
          filters: [{ field: "runtime_id", operator: "eq", value: runtime.id }],
          from_timestamp: "2026-01-01T00:00:00Z",
          to_timestamp: "2027-01-01T00:00:00Z",
        } as Parameters<typeof sa.metrics.query>[0]);
        expect(metrics, "a metrics response").toBeTruthy();

        // Access tags are an administrator's to write: the owner's token, not
        // the service account, which acts as the project's agent member.
        const memberQuiet = new IntrospectionClient({
          token: memberToken,
          advanced: {
            baseApiUrl: settings.baseApiUrl,
            dpUrl: sa.advancedOptions.dpUrl,
            fetch: NATIVE_FETCH,
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
            "description": "the walk's tag, updated",
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

        // The annotation targets the conversation's first item (its span).
        const items = await sa.conversations.items.list(conversationId);
        const target = items.data[0]!;
        if (target.trace_id && target.span_id) {
          await member.annotations.create(
            { trace_id: target.trace_id, span_id: target.span_id },
            { labels: ["walk"] },
            // An event id derived from the span, so the request replays; the
            // SDK would mint one.
            {
              event_id: spanEventId(target.trace_id, target.span_id, "labels"),
            },
          );
          // Reviewers by email resolve through the Control Plane's member list,
          // which a member's Data Plane token cannot read (design doc §9); the
          // walk clears them, which needs no lookup, and reaches the check made
          // before any request.
          const span = { trace_id: target.trace_id, span_id: target.span_id };
          await member.annotations.create(
            span,
            { reviewerEmails: [] },
            {
              event_id: spanEventId(
                target.trace_id,
                target.span_id,
                "reviewers",
              ),
            },
          );
          await expect(
            member.annotations.create(span, { reviewerEmails: [" "] }),
          ).rejects.toBeInstanceOf(ValidationError);
          const annotations = await settled(
            mode,
            async () => {
              const out = [];
              for await (const a of member.annotations.list({
                conversation_id: conversationId,
              } as Parameters<typeof member.annotations.list>[0]))
                out.push(a);
              return out;
            },
            async () => {
              const out = [];
              for await (const a of memberQuiet.annotations.list({
                conversation_id: conversationId,
              } as Parameters<typeof memberQuiet.annotations.list>[0]))
                out.push(a);
              return out;
            },
            (rows) => rows.length > 0 || settings.target === "compose",
            { timeoutMs: 60_000, intervalMs: 3_000, label: "annotations" },
          );
          // An annotation is appended through the OTLP self-ingest path and
          // reads back once the processor has landed it; on the local stack
          // it stays `visible: false`, a finding the design doc records.
          if (settings.target !== "compose") {
            expect(annotations[0]!.labels).toContain("walk");
          }
          const events = await settled(
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
            async () => {
              const out = [];
              for await (const e of saQuiet.events.list({
                event_name: "introspection.annotation",
                conversation_id: conversationId,
              }))
                out.push(e);
              return out;
            },
            (rows) => rows.length > 0 || settings.target === "compose",
            {
              timeoutMs: 60_000,
              intervalMs: 3_000,
              label: "annotation events",
            },
          );
          if (events.length > 0) {
            await sa.events.get((events[0] as { id: string }).id);
          }
          const eventTable = await sa.events
            .listArrow({
              event_name: "introspection.annotation",
              conversation_id: conversationId,
            } as Parameters<typeof sa.events.listArrow>[0])
            .readAll();
          expect(eventTable.numRows).toBeGreaterThanOrEqual(events.length);
          const facets = await raw(member.dpHttp).get<unknown>(
            "/v1/annotations/facets",
            {
              conversation_id: conversationId,
            },
          );
          expect(facets).toBeTruthy();
          const navigation = await raw(member.dpHttp).get<unknown>(
            "/v1/annotations/navigation",
            {
              trace_id: target.trace_id,
              span_id: target.span_id,
            },
          );
          expect(navigation).toBeTruthy();
        }
        shareId = share.id;

        // The AAuth surfaces and the runner's app connections, read empty.
        const missions = await sa.missions.list();
        expect(missions.records).toEqual([]);
        const approvals = await sa.approvals.list();
        expect(approvals.records).toEqual([]);
        // `/v1/connections` is the apps a member connects through an app
        // (Pipedream) connector, which needs that provider's credentials; with
        // none on the project every route answers 404 (member-connections.md).
        await expectNotFound(async () => await member.connections.list());
        await expectNotFound(() =>
          member.connections.get("019a1000-0000-7000-8000-0000000000c1"),
        );
        await expectNotFound(() =>
          member.connections.delete("019a1000-0000-7000-8000-0000000000c1"),
        );
        await expectNotFound(() =>
          member.connections.create({
            app: "gmail",
            runtime: WALK.runtimeSlug,
          }),
        );
        // A client with no runtime of its own refuses before any request.
        await expect(
          member.connections.create({ app: "gmail" } as Parameters<
            typeof member.connections.create
          >[0]),
        ).rejects.toThrow(/runtime/);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "14: eval — a trial on the runtime, graded by the recipe's judge; an experiment over two versions",
    async (ctx) => {
      await steps.run(ctx, "eval", async () => {
        // What eval compose services run as, and the org's provider installs.
        const images = await sa.images.list();
        if (images.records.length > 0)
          await sa.images.get(images.records[0]!.id);
        await owner.integrations.list();
        const judges = await sa.judges.list({
          project: project.id,
          runtime_group_id: runtime.runtime_group_id,
        });
        judge = judges.records.find((j) => j.name === "greeting")!;
        expect(judge, "the recipe's judge is synced").toBeTruthy();
        const readJudge = await sa.judges.get(judge.id, project.id);
        expect(readJudge.name).toBe("greeting");
        await sa.judges.update(
          judge.id,
          { enabled: true, sample_rate: 1 },
          project.id,
        );

        // A trial needs the evals capability, which the runner's session never
        // carries; the service account holds `tasks:eval` and names the runtime.
        const created = await sa.tasks.create({
          kind: "eval",
          runtime_id: runtime.id,
          commands: true,
          prompt: prompt(settings),
          agent_name: settings.agent,
          metadata: { suite: "walk", walk_run: WALK.run },
          idle_timeout_seconds: 120,
        } as Parameters<typeof sa.tasks.create>[0]);
        evalTask = created.task;
        // `metadata` is the platform's (the launch path, the active run) and
        // differs between a warm pod and a baked image; the walk's own key is
        // asserted and the rest left out of the snapshot.
        expect(evalTask.metadata?.suite).toBe("walk");
        expect(stable({ ...evalTask, metadata: undefined }))
          .toMatchInlineSnapshot(`
            {
              "agent": {
                "sandbox_status": "provisioning",
                "session_id": null,
              },
              "automation_id": null,
              "completed_at": null,
              "conversation_metadata": null,
              "created_at": "[timestamp]",
              "display_index": "[number]",
              "id": "[uuid]",
              "is_archived": false,
              "kind": "eval",
              "last_user_message_at": "[timestamp]",
              "member_id": "[uuid]",
              "metadata": undefined,
              "org_id": "[uuid]",
              "project_id": "[uuid]",
              "runtime_group_id": "[uuid]",
              "runtime_id": "[uuid]",
              "started_at": null,
              "status": "pending",
              "tags": [],
              "title": "Call the \`echo\` tool from the declared \`hello-mcp\` MCP server with the message \`hello from the public MCP\`. Write the echoed value exactly, with no quotes or additional formatting, to \`/workspace/outputs/greeting.txt\`. Then run \`echo…",
              "updated_at": "[timestamp]",
            }
          `);
        // Read the run's stream to its end, then let the row settle: what the
        // trial says is the model's, and the judge grades the trajectory.
        for await (const _ev of sa.tasks.runs.stream(
          evalTask.id,
          created.run.id,
        )) {
          // drain
        }
        evalTask = await settled(
          mode,
          () => sa.tasks.get(evalTask.id),
          () => saQuiet.tasks.get(evalTask.id),
          (t) =>
            ["idle", "awaiting_user", "completed", "failed"].includes(t.status),
          { timeoutMs: 180_000, intervalMs: 2_000, label: "the trial" },
        );
        expect(["idle", "awaiting_user", "completed"]).toContain(
          evalTask.status,
        );

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
                  "judge_definition_hash": "[digest]",
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
        // Bandit routing needs a stable subject to assign an arm to.
        const experimentRunner = await sa.experiments.runById(experiment.id, {
          identity: { user_id: "sdk-walk-user" },
        } as Parameters<typeof sa.experiments.runById>[1]);
        expect(experimentRunner, "a runner on the experiment").toBeTruthy();
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
                  "judge_definition_hash": "[digest]",
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
        const second = await sa.experiments.create({
          name: "The walk's cancelled experiment",
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
        await sa.experiments.startById(second.id);
        const cancelled = await sa.experiments.cancelById(second.id);
        expect(cancelled.status).toBe("cancelled");
        await owner.experiments.delete(second.id, project.id);
      });
    },
    BAKE_TIMEOUT,
  );

  it(
    "15: commands — exec and download inside the eval's sandbox",
    async (ctx) => {
      await steps.run(ctx, "commands", async () => {
        const command = async (spec: TaskCommandSpec) => {
          const created = await sa.tasks.commands.create(evalTask.id, spec);
          return settled(
            mode,
            () => sa.tasks.commands.get(evalTask.id, created.id),
            () => saQuiet.tasks.commands.get(evalTask.id, created.id),
            (c: TaskCommand) =>
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
        const listed = await sa.tasks.commands.list(evalTask.id);
        expect(listed.records.length).toBeGreaterThanOrEqual(2);

        // Judging runs in the sandbox at teardown and calls the judge's own
        // grader model through the egress. On the scripted target that grader
        // is the model double, which returns no verdict, so a judgement is
        // asserted only where a real model grades (design doc §10).
        const judgements = await settled(
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
          async () => {
            const out = [];
            for await (const e of saQuiet.events.list({
              event_name: "introspection.judgement",
              judge_id: judge.id,
            } as Parameters<typeof saQuiet.events.list>[0]))
              out.push(e);
            return out;
          },
          (rows) => rows.length > 0 || settings.agent === "scripted",
          { timeoutMs: BAKE_TIMEOUT, intervalMs: 10_000, label: "judgement" },
        );
        if (settings.agent !== "scripted") {
          expect(
            judgements.length,
            "the recipe's judge graded the trial",
          ).toBeGreaterThan(0);
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
    "17: access — Avery's work, read by Blake (a member share), Casey (the platform group tag), Drew (an administrator) and Emery (only a project-wide share)",
    async (ctx) => {
      await steps.run(ctx, "access", async () => {
        // The owner login is privileged, so its quiet client polls for what
        // Avery makes; every person's own read is then recorded once.
        const ownerQuiet = new IntrospectionClient({
          token: memberToken,
          advanced: {
            baseApiUrl: settings.baseApiUrl,
            dpUrl: member.advancedOptions.dpUrl,
            fetch: NATIVE_FETCH,
          },
        });
        // Drew, the administrator: no person signs in on a walk, so Drew is an
        // application bound to the organisation's admin agent member, whose
        // client-credentials token is privileged.
        let adminAgentId: string | undefined;
        for await (const m of owner.members.list({ member_type: "agent" }))
          if (m.role === "admin") adminAgentId = m.id;
        expect(adminAgentId, "the organisation's admin agent").toBeTruthy();
        const drewApp = await owner.applications.create(
          {
            name: WALK.adminName,
            application_type: "service_account",
            allowed_scopes: [
              "conversations:read",
              "tasks:read",
              "files:read",
              "shares:read",
              "shares:delete",
            ],
            agent_member_id: adminAgentId,
          },
          project.id,
        );
        const drewSecret = await owner.applications.secrets.create(drewApp.id, {
          name: "drew",
        });
        const drewToken = await serviceAccountToken({
          clientId: drewApp.client_id,
          clientSecret: drewSecret.secret!,
          project: project.id,
          baseApiUrl: settings.baseApiUrl,
        });
        const drew = new IntrospectionClient({
          token: drewToken.access_token,
          advanced: {
            baseApiUrl: settings.baseApiUrl,
            dpUrl: drewToken.dp_url ?? undefined,
          },
        });

        type Name = keyof typeof WALK.personas;
        const people = {} as Record<
          Name,
          {
            id: string;
            client: Awaited<ReturnType<typeof sa.runtimes.runById>>;
          }
        >;
        for (const [name, tags] of Object.entries(WALK.personas) as [
          Name,
          string[],
        ][]) {
          const externalUserId = `user:walk-${name}`;
          const displayName = name[0]!.toUpperCase() + name.slice(1);
          // Members have no public delete, so a persona from an earlier run is
          // reused and its name and tags set again.
          const existing = await owner.members.list({
            member_type: "customer",
            external_user_id: [externalUserId],
          });
          const id =
            existing.records[0]?.id ??
            (
              await owner.members.create({
                member_type: "customer",
                external_user_id: externalUserId,
                name: displayName,
                tags,
              })
            ).id;
          if (existing.records[0]) {
            await owner.members.update(id, { name: displayName, tags });
          }
          const client = await sa.runtimes.runById(runtime.id, {
            environment: "production",
            agent_name: settings.agent,
            identity: { user_id: `walk-${name}` },
          } as Parameters<typeof sa.runtimes.runById>[1]);
          people[name] = { id, client };
        }
        const { avery, blake, casey, emery } = people;

        // Avery makes everything first: a task tagged for the platform group, its
        // conversation and output file, and a file of their own.
        const started = await avery.client.tasks.start({
          prompt: prompt(settings),
          agent_name: settings.agent,
          metadata: { suite: "walk", walk_run: WALK.run },
          conversation_metadata: {
            suite: "walk",
            walk_run: WALK.run,
            persona: "avery",
          },
          tags: [WALK.groupTag, "suite:walk"],
          idle_timeout_seconds: 180,
        } as Parameters<typeof avery.client.tasks.start>[0]);
        await started.text();
        const averyTask = await settled(
          mode,
          () => avery.client.tasks.get(started.task!.id),
          () => ownerQuiet.tasks.get(started.task!.id),
          (t) => ["idle", "awaiting_user", "completed"].includes(t.status),
          { timeoutMs: 300_000, intervalMs: 5_000, label: "Avery's task" },
        );
        expect(averyTask.tags).toEqual([WALK.groupTag, "suite:walk"]);
        // A row carrying two tags is found by either one.
        for (const tag of [WALK.groupTag, "suite:walk"]) {
          let found = false;
          for await (const t of member.tasks.list({ tag }))
            if (t.id === averyTask.id) found = true;
          expect(found, `the task list by ${tag}`).toBe(true);
        }
        expect(averyTask.conversation_metadata).toEqual({
          suite: "walk",
          walk_run: WALK.run,
          persona: "avery",
        });
        const averyConversation = averyTask.id;
        const averyOutputs = await settled(
          mode,
          async () =>
            (await member.files.list({ task_id: averyTask.id })).records,
          async () =>
            (await ownerQuiet.files.list({ task_id: averyTask.id })).records,
          (files) => files.some((f) => f.name.endsWith(WALK.outputFileName)),
          { timeoutMs: 120_000, intervalMs: 3_000, label: "Avery's output" },
        );
        const averyOutput = averyOutputs.find((f) =>
          f.name.endsWith(WALK.outputFileName),
        )!;
        await settled(
          mode,
          () => member.conversations.get(averyConversation),
          () => ownerQuiet.conversations.get(averyConversation),
          (c) => c.metrics.llm_call_count > 0,
          {
            timeoutMs: 120_000,
            intervalMs: 5_000,
            label: "Avery's conversation",
          },
        );
        const averyFile = await avery.client.files.createText({
          name: WALK.personaFileName,
          content: "Avery's notes",
          mime_type: "text/plain",
          metadata: { suite: "walk", walk_run: WALK.run },
        });

        // Both keys must sit on the conversation (ANDed). The filter reads the
        // conversation's root span, which lands a moment after the task.
        const byMetadata = async (client: IntrospectionClient) => {
          for await (const c of client.conversations.list({
            metadata: { suite: "walk", walk_run: WALK.run, persona: "avery" },
          }))
            if (c.id === averyConversation) return true;
          return false;
        };
        const filtered = await settled(
          mode,
          () => byMetadata(member),
          () => byMetadata(ownerQuiet),
          (found) => found,
          { timeoutMs: 60_000, label: "conversation_metadata filter" },
        );
        expect(filtered, "conversation_metadata filters").toBe(true);

        const can = (read: () => Promise<unknown>) =>
          read().then(
            () => true,
            (err: unknown) => {
              if (err instanceof NotFoundError) return false;
              throw err;
            },
          );
        type Who = {
          client: Pick<
            IntrospectionClient,
            "tasks" | "files" | "conversations"
          >;
        };
        const reads = async (who: Who) => ({
          conversation: await can(() =>
            who.client.conversations.get(averyConversation),
          ),
          task: await can(() => who.client.tasks.get(averyTask.id)),
          file: await can(() => who.client.files.get(averyFile.id)),
          output: await can(() => who.client.files.get(averyOutput.id)),
        });
        // Each list shows a person what a read by id lets them open, and a
        // filter narrows it: the task list is filtered by the group tag.
        const lists = async (who: Who) => {
          const conversations: string[] = [];
          for await (const c of who.client.conversations.list({
            runtime_group_id: runtime.runtime_group_id,
          }))
            conversations.push(c.id);
          const tasks: string[] = [];
          for await (const t of who.client.tasks.list({ tag: WALK.groupTag }))
            tasks.push(t.id);
          const files: string[] = [];
          for await (const f of who.client.files.list({})) files.push(f.id);
          return {
            conversation: conversations.includes(averyConversation),
            task: tasks.includes(averyTask.id),
            file: files.includes(averyFile.id),
          };
        };
        const readsAndLists = async (who: Who) => {
          const read = await reads(who);
          expect(await lists(who), "a list agrees with reads by id").toEqual({
            conversation: read.conversation,
            task: read.task,
            file: read.file,
          });
          return read;
        };
        const matrix = async () => ({
          avery: await readsAndLists(avery),
          blake: await readsAndLists(blake),
          casey: await readsAndLists(casey),
          drew: await readsAndLists({ client: drew }),
          emery: await readsAndLists(emery),
        });
        const none = {
          conversation: false,
          task: false,
          file: false,
          output: false,
        };
        const all = {
          conversation: true,
          task: true,
          file: true,
          output: true,
        };
        // Casey holds one of the task's two tags, which opens the task and its
        // conversation; the output file carries no tags of its own, so a tag
        // reader cannot open it (output files do not inherit the task's tags).
        const byTag = {
          conversation: true,
          task: true,
          file: false,
          output: false,
        };
        expect(await matrix(), "before any share").toEqual({
          avery: all,
          blake: none,
          casey: byTag,
          drew: all,
          emery: none,
        });

        // A share to one member, and one to everyone holding the platform group tag.
        const toBlake = await avery.client.shares.create({
          resource_type: "conversation",
          resource_id: averyConversation,
          granted_member_id: blake.id,
        });
        // A conversation share may hide the history before an instant.
        const hidden = await avery.client.shares.update(toBlake.id, {
          visible_from: "2026-01-01T00:00:00Z",
        });
        expect(hidden.visible_from).toBeTruthy();
        const shown = await avery.client.shares.update(toBlake.id, {
          visible_from: null,
        });
        expect(shown.visible_from).toBeNull();
        const toPlatform = await avery.client.shares.create({
          resource_type: "file",
          resource_id: averyFile.id,
          granted_tag: WALK.groupTag,
        });
        expect(await matrix(), "a member share and a tag share").toEqual({
          avery: all,
          // A conversation share opens the conversation, never the task.
          blake: { ...none, conversation: true },
          casey: { ...byTag, file: true },
          drew: all,
          emery: none,
        });

        // A share naming neither opens the conversation to the whole project.
        const toProject = await avery.client.shares.create({
          resource_type: "conversation",
          resource_id: averyConversation,
        });
        expect((await matrix()).emery, "a project-wide share").toEqual({
          ...none,
          conversation: true,
        });

        // Revoked, every share stops granting. A runner cannot hold
        // `shares:delete`, so Avery cannot revoke their own share; the grantor
        // or an administrator may, so Drew does.
        for (const share of [toBlake, toPlatform, toProject]) {
          await drew.shares.delete(share.id);
        }
        expect(await matrix(), "every share revoked").toEqual({
          avery: all,
          blake: none,
          casey: byTag,
          drew: all,
          emery: none,
        });

        await member.files.delete(averyFile.id);
        await member.tasks.delete(averyTask.id);
        await owner.applications.delete(drewApp.id, project.id);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "18: a change merged — a branch pushed to the hosted repository, merged into main",
    async (ctx) => {
      await steps.run(ctx, "merge", async () => {
        if (mode !== "replay") {
          pushBranch(
            { url: hostedUrl, bearer: memberToken },
            WALK.changeBranch,
            { path: "WALK.md", content: "A change the walk merges.\n" },
          );
        }
        let pushed = false;
        for await (const b of sa.repositories.branches(repository.id, {
          q: "pr",
        }))
          if (b.name === WALK.changeBranch) pushed = true;
        expect(pushed, "the pushed branch").toBe(true);
        const merged = await sa.repositories.merge(repository.id, {
          base: "main",
          head: WALK.changeBranch,
          commit_message: `Merge ${WALK.changeBranch}`,
        });
        expect(merged, "a merge commit").not.toBeNull();
        expect(merged!.base).toBe("main");
        expect(merged!.parents).toHaveLength(2);
        // The same merge again is the same request (the data plane keys it by
        // repository, base and head, so a timed-out one can be resent), so it
        // answers with the merge already made rather than GitHub's 204.
        const again = await sa.repositories.merge(repository.id, {
          base: "main",
          head: WALK.changeBranch,
        });
        expect(again?.sha).toBe(merged!.sha);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "19: members and keys — the owner's reads, a development API key, the organisation",
    async (ctx) => {
      await steps.run(ctx, "members and keys", async () => {
        const members = [];
        for await (const m of owner.members.list()) members.push(m);
        expect(members.length).toBeGreaterThan(0);
        await owner.members.get(members[0]!.id);
        const org = await raw(owner.cpHttp).get<{ id: string; slug: string }>(
          "/v1/organizations/me",
        );
        // An invite outlives the project (members are the organisation's), so
        // a repeat run finds the one the last run sent rather than minting
        // another; and a person belongs to one organisation, so the address
        // names this one, or a second organisation's walk answers 409.
        const email = `walk-member@${org.slug}.example.com`;
        const invited =
          members.find((m) => m.email === email) ??
          (await owner.members.create({
            email,
            name: "Walk member",
            role: "member",
          } as Parameters<typeof owner.members.create>[0]));
        expect(invited.email).toBe(email);
        expect(invited.role).toBe("member");
        const renamed = await owner.members.update(invited.id, {
          name: "Walk member (renamed)",
        });
        expect(renamed.name).toBe("Walk member (renamed)");
        const me = await raw(owner.cpHttp).get<{ org_id: string }>(
          "/v1/oidc/me",
        );
        expect(me.org_id).toBe(project.org_id);
        apiKey = await sa.apiKeys.create(
          { name: "walk", environment: "development", allow: ["runtimes"] },
          project.id,
        );
        expect(
          apiKey.api_key,
          "the plaintext key is returned once",
        ).toBeTruthy();
        expect(stable({ ...apiKey, api_key: undefined }))
          .toMatchInlineSnapshot(`
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
              "key_display": "[redacted]",
              "key_prefix": "[redacted]",
              "key_suffix": "[redacted]",
              "last_used_at": null,
              "member_id": "[uuid]",
              "name": "walk",
              "org_id": "[uuid]",
              "prefix": "[redacted]",
              "project_id": "[uuid]",
              "redacted_key": "[redacted]",
              "scope": "telemetry:write projects:read repositories:read recipes:read recipes:write runtimes:read runtimes:write experiments:read experiments:write tasks:read tasks:write tasks:delete files:read files:write conversations:read events:read metrics:read shares:read shares:write shares:delete connectors:read connectors:write annotations:read approvals:read approvals:write",
              "status": "active",
            }
          `);
        // The key list is its own envelope, `api_keys`, not a page; the SDK
        // answers the array.
        const keys = await sa.apiKeys.list({ project: project.id });
        expect(keys.some((k) => k.id === apiKey.id)).toBe(true);
        await sa.apiKeys.update(
          apiKey.id,
          { name: `${WALK.apiKeyName} (renamed)` },
          project.id,
        );
        await sa.apiKeys.acknowledge(apiKey.id, project.id);
        // The organisation's name and slug are whoever is running the walk.
        expect(org.slug).toBeTruthy();
        expect(stable({ ...org, name: undefined, slug: undefined }))
          .toMatchInlineSnapshot(`
          {
            "external_org_id": "[id]",
            "hosted_git": true,
            "id": "[uuid]",
            "image_url": null,
            "name": undefined,
            "slug": undefined,
          }
        `);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "20: teardown — everything the walk created, in reverse",
    async (ctx) => {
      await steps.run(ctx, "teardown", async () => {
        // The default file list omits the upload a task holds, so it goes by id.
        await sa.files.delete(inputFile.id);
        await removeWalkResources(
          owner,
          member,
          project,
          sa,
          (name) => !!name?.includes(settings.run),
        );
        await expectNotFound(() => sa.tasks.get(task.id));
        await expectNotFound(() => sa.files.get(inputFile.id));
        await expectNotFound(() => sa.runtimes.get(runtimeV2.id));
        // The `hello-mcp` connector is the project's, shared by every run.
        expect((await sa.connectors.get(connector.id)).id).toBe(connector.id);
        await expectNotFound(() => sa.recipes.get(recipe.id));
        await expectNotFound(() =>
          owner.applications.get(application.id, project.id),
        );
        // The login's project stays.
        expect((await owner.projects.get(project.id)).id).toBe(project.id);
      });
    },
    STEP_TIMEOUT,
  );
});

/**
 * What runs left in the project, by the run suffix their names carry: `take`
 * says which (this run's at the teardown, a crashed run's at step 0).
 * Deleting is the owner's where a `:delete` scope is never minted to an
 * application (runtimes, recipes, experiments, repositories); the member's
 * Data Plane token does the rest. The `hello-mcp` connector is the project's,
 * shared by every run, and stays.
 */
async function removeWalkResources(
  owner: IntrospectionClient,
  member: IntrospectionClient,
  project: Project,
  // Tasks and files are listed as the project's agent member (the service
  // account) where it exists: a member's own token lists only the tasks it
  // owns, not the runner's, which a customer identity owns.
  dp: IntrospectionClient,
  take: (name: string | null | undefined) => boolean,
): Promise<void> {
  const q = { project: project.id };
  const ignore404 = (err: unknown) => {
    if (!(err instanceof NotFoundError)) throw err;
  };
  for (const key of await owner.apiKeys.list(q)) {
    if (take(key.name)) await owner.apiKeys.delete(key.id, q);
  }
  for await (const a of member.automations.list()) {
    if (take(a.name)) await member.automations.delete(a.id);
  }
  for await (const t of member.tags.list("access")) {
    if (take(t.name))
      await member.tags.delete("access", t.name).catch(ignore404);
  }
  const tasks = new Set<string>();
  for await (const task of dp.tasks.list()) {
    const run = (task.metadata as { walk_run?: string } | null)?.walk_run;
    if (take(run)) tasks.add(task.id);
  }
  const walkFiles: string[] = [];
  for await (const f of dp.files.list({})) {
    if (take(f.name) || (f.task_id && tasks.has(f.task_id))) {
      walkFiles.push(f.id);
    }
  }
  for (const id of tasks) await dp.tasks.delete(id).catch(ignore404);
  for await (const s of dp.shares.list({ resource_type: "file" })) {
    if (walkFiles.includes(s.resource_id)) await dp.shares.delete(s.id);
  }
  for (const id of walkFiles) await dp.files.delete(id).catch(ignore404);
  for await (const x of owner.experiments.list({ project: project.id })) {
    if (take(x.name)) await owner.experiments.delete(x.id, project.id);
  }
  const groups = new Set<string>();
  for await (const r of owner.runtimes.list({ project: project.id })) {
    if (!take(r.slug)) continue;
    if (r.runtime_group_id) groups.add(r.runtime_group_id);
    // Deleting the group's live version takes its siblings with it.
    await owner.runtimes.delete(r.id, project.id).catch(ignore404);
  }
  for await (const e of owner.endpoints.list({
    project: project.id,
    mcp_server_id: WALK.mcpServerId,
  })) {
    if (e.runtime_group_id && groups.has(e.runtime_group_id)) {
      await owner.endpoints.delete(e.id, project.id).catch(ignore404);
    }
  }
  for await (const v of owner.variables.list(q)) {
    if (take(v.name)) await owner.variables.delete(v.id, project.id);
  }
  for await (const c of owner.credentials.list(q)) {
    if (take(c.name)) await owner.credentials.delete(c.id, project.id);
  }
  for (const repo of await owner.repositories.list({ project: project.id })) {
    if (!take(repo.slug)) continue;
    for await (const r of owner.recipes.list({
      project: project.id,
      repository_id: repo.id,
    })) {
      await owner.recipes.delete(r.id, project.id);
    }
    await owner.repositories.delete(repo.id, q);
  }
  for await (const a of owner.applications.list(q)) {
    if (take(a.name)) await owner.applications.delete(a.id, project.id);
  }
  // Step 1's sibling, should a run have crashed between its create and delete.
  for (const other of (await owner.projects.list()).records) {
    if (other.id !== project.id && take(other.slug)) {
      await owner.projects.delete(other.id).catch(ignore404);
    }
  }
}

async function expectNotFound(read: () => Promise<unknown>): Promise<void> {
  const outcome = await read().then(
    () => "found",
    (err: unknown) => (err instanceof NotFoundError ? "not found" : err),
  );
  expect(outcome).toBe("not found");
}
