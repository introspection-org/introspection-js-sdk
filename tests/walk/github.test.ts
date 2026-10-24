/**
 * The SDK walk's GitHub lane: `introspection-org/recipe-smoke-test-agent`
 * linked through the organisation's GitHub integration, a runtime from its
 * `smoke-test-agent-walk` manifest (which grants `contents: write` over the
 * repository), a scripted task that commits `probe/coverage-bump.txt` on
 * `walk-change` and pushes it from the sandbox, and the merge of that branch
 * into `walk` through the platform, read back. `main` is never written, so the
 * smoke probe that pins it never re-bakes.
 *
 * Live, it needs `WALK_GITHUB=1` and a Control Plane that can reach the
 * repository: `GITHUB_DEV_PAT` (a fine-grained token for that one repository,
 * Contents read and write) on a development plane, or the GitHub App's
 * installation. Replay needs the committed recording; without either, it skips.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Polly } from "@pollyjs/core";
import {
  IntrospectionClient,
  NotFoundError,
} from "@introspection-sdk/introspection-node";
import type {
  Project,
  Recipe,
  Repository,
  Runtime,
} from "@introspection-sdk/introspection-node";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPollyMode, setupPolly } from "../polly-setup";
import {
  BOOTSTRAP_FILE,
  NATIVE_FETCH,
  raw,
  settled,
  Steps,
  walkSettings,
} from "./support";
import type { WalkSettings } from "./support";

const RECORDING = "github-walk";
const STEP_TIMEOUT = 10 * 60_000;
const BAKE_TIMEOUT = 30 * 60_000;
const RECORDINGS_DIR =
  process.env.POLLY_RECORDINGS_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../recordings");
const mode = getPollyMode();

const GITHUB = {
  repo: "introspection-org/recipe-smoke-test-agent",
  url: "https://github.com/introspection-org/recipe-smoke-test-agent",
  /** The manifest whose runtime may write to the repository. */
  recipe: "smoke-test-agent-walk",
  /** The long-lived branch the walk merges into; `main` stays untouched. */
  base: "walk",
  /** The branch the sandbox pushes. */
  head: "walk-change",
  file: "probe/coverage-bump.txt",
  content: "A change the SDK walk pushes from a sandbox and merges.\n",
} as const;

/** The scripted task: commit the file on `walk-change` and push it. */
function directive(): string {
  const checkout = `/workspace/repos/${GITHUB.repo.split("/")[1]}`;
  const command = [
    `cd ${checkout}`,
    `git checkout -B ${GITHUB.head}`,
    `mkdir -p ${path.dirname(GITHUB.file)}`,
    `printf %s ${JSON.stringify(GITHUB.content)} > ${GITHUB.file}`,
    `git add ${GITHUB.file}`,
    `GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z ` +
      `git -c user.name='SDK walk' -c user.email=walk@example.com commit --quiet --allow-empty -m 'walk: coverage bump'`,
    `git push --quiet --force origin HEAD:refs/heads/${GITHUB.head}`,
    `git rev-parse HEAD`,
  ].join(" && ");
  return `<<SCRIPT ${JSON.stringify({
    reply: "Pushed the coverage bump.",
    tools: [{ name: "bash", arguments: { command } }],
  })}>>`;
}

const recorded = fs.existsSync(
  `${RECORDINGS_DIR}/${RECORDING}/${BOOTSTRAP_FILE}`,
);
const runnable = mode === "replay" ? recorded : process.env.WALK_GITHUB === "1";
const lane = runnable ? describe.sequential : describe.skip;

lane("SDK walk: GitHub write-back", () => {
  const steps = new Steps();
  let polly: Polly;
  let settings: WalkSettings;
  let owner: IntrospectionClient;
  let ownerQuiet: IntrospectionClient;
  let member: IntrospectionClient;
  let project: Project;
  let repository: Repository;
  let recipe: Recipe;
  let runtime: Runtime;

  beforeAll(() => {
    polly = setupPolly({ recordingName: RECORDING, ordered: true });
    settings = walkSettings(mode);
    if (mode === "replay") {
      const bootstrap = JSON.parse(
        fs.readFileSync(
          `${RECORDINGS_DIR}/${RECORDING}/${BOOTSTRAP_FILE}`,
          "utf8",
        ),
      ) as { project_id: string };
      settings = { ...settings, bootstrapProjectId: bootstrap.project_id };
    }
    owner = new IntrospectionClient({
      cpSession: settings.cpSession,
      advanced: { baseApiUrl: settings.baseApiUrl },
    });
    ownerQuiet = new IntrospectionClient({
      cpSession: settings.cpSession,
      advanced: { baseApiUrl: settings.baseApiUrl, fetch: NATIVE_FETCH },
    });
  }, STEP_TIMEOUT);

  afterAll(async () => {
    await polly?.stop();
  }, STEP_TIMEOUT);

  it(
    "0: the login's project, with a crashed run's link removed",
    async (ctx) => {
      await steps.run(ctx, "clean slate", async () => {
        project = await owner.projects.get(settings.bootstrapProjectId!);
        if (mode === "record") {
          fs.mkdirSync(`${RECORDINGS_DIR}/${RECORDING}`, { recursive: true });
          fs.writeFileSync(
            `${RECORDINGS_DIR}/${RECORDING}/${BOOTSTRAP_FILE}`,
            JSON.stringify({ project_id: project.id }) + "\n",
          );
        }
        // The owner's Data Plane token for the project, for the merge.
        const minted = await raw(owner.cpHttp).post<{ access_token: string }>(
          "/v1/tokens",
          { project: project.id, expires_hours: 24 },
        );
        member = new IntrospectionClient({
          token: minted.access_token,
          advanced: {
            baseApiUrl: settings.baseApiUrl,
            dpUrl: settings.dpUrl ?? undefined,
          },
        });
        await removeLink(owner, project);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "1: link — the repository, through the organisation's GitHub integration",
    async (ctx) => {
      await steps.run(ctx, "link", async () => {
        let integrationId: string | undefined;
        for await (const i of owner.integrations.list())
          if (i.type === "github") integrationId = i.id;
        expect(
          integrationId,
          "a GitHub integration on the organisation",
        ).toBeTruthy();
        // `POST /v1/repositories` is documented for the CLI only.
        repository = await raw(owner.cpHttp).post<Repository>(
          "/v1/repositories",
          {
            provider: "github",
            integration_id: integrationId,
            url: GITHUB.url,
            name: GITHUB.repo,
          },
          { project: project.id },
        );
        expect(repository.provider).toBe("github");
        const listed = await owner.repositories.list({
          project: project.id,
          slug: GITHUB.repo,
        });
        expect(listed.some((r) => r.id === repository.id)).toBe(true);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "2: runtime — the write-granting manifest, at the head of `walk`, baked",
    async (ctx) => {
      await steps.run(ctx, "runtime", async () => {
        // A recipe pins the commit it was made at, so the head of `walk` is
        // read first, through the linked repository.
        const head = (
          await member.repositories.commits(repository.id, { sha: GITHUB.base })
        ).records[0];
        expect(head?.sha, "a commit on `walk`").toBeTruthy();
        recipe = await owner.recipes.create({
          project: project.id,
          repository_id: repository.id,
          name: GITHUB.recipe,
          git_ref: GITHUB.base,
          git_commit_sha: head!.sha,
        });
        // A runtime made through the API carries the config it is given; the
        // manifest's `runtime.github` reaches only runtimes a push creates.
        const created = await owner.runtimes.create({
          project: project.id,
          recipe_id: recipe.id,
          name: GITHUB.recipe,
          slug: GITHUB.recipe,
          config_json: {
            github: {
              repositories: [GITHUB.repo],
              permissions: { contents: "write" },
            },
          },
        });
        runtime = await settled(
          mode,
          () => owner.runtimes.get(created.id, { project: project.id }),
          () => ownerQuiet.runtimes.get(created.id, { project: project.id }),
          (r) =>
            r.image_build_status === "ready" ||
            r.image_build_status === "failed",
          {
            timeoutMs: BAKE_TIMEOUT,
            intervalMs: 10_000,
            label: "runtime bake",
          },
        );
        expect(runtime.image_build_status).toBe("ready");
      });
    },
    BAKE_TIMEOUT,
  );

  it(
    "3: push — a scripted task commits on `walk-change` and pushes it from the sandbox",
    async (ctx) => {
      await steps.run(ctx, "push", async () => {
        const runner = await owner.runtimes.runById(runtime.id, {
          environment: "production",
          agent_name: "scripted",
        } as Parameters<typeof owner.runtimes.runById>[1]);
        const started = await runner.tasks.start({
          prompt: `Commit and push the coverage bump.\n\n${directive()}`,
          agent_name: "scripted",
          repositories: [{ repo: GITHUB.repo, ref: GITHUB.base }],
          metadata: { suite: "github-walk" },
          idle_timeout_seconds: 180,
        } as Parameters<typeof runner.tasks.start>[0]);
        expect((await started.text()).length).toBeGreaterThan(0);
        let pushed = false;
        for await (const b of member.repositories.branches(repository.id, {
          q: "walk",
        }))
          if (b.name === GITHUB.head) pushed = true;
        expect(pushed, "the sandbox pushed the branch").toBe(true);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "4: merge — `walk-change` into `walk` through the merges API, read back",
    async (ctx) => {
      await steps.run(ctx, "merge", async () => {
        const merged = await member.repositories.merge(repository.id, {
          base: GITHUB.base,
          head: GITHUB.head,
          commit_message: `Merge ${GITHUB.head}`,
        });
        expect(merged, "a merge commit").not.toBeNull();
        expect(merged!.base).toBe(GITHUB.base);
        const file = await member.repositories.contents.get(
          repository.id,
          GITHUB.file,
          {
            ref: GITHUB.base,
          },
        );
        expect(JSON.stringify(file)).toContain("coverage");
        const again = await member.repositories.merge(repository.id, {
          base: GITHUB.base,
          head: GITHUB.head,
        });
        // The same merge again is the same request (the data plane keys it by
        // repository, base and head, so a timed-out one can be resent), so it
        // answers with the merge already made rather than GitHub's 204.
        expect(again?.sha, "merging again returns the same merge").toBe(
          merged!.sha,
        );
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "5: teardown — the runtime, the recipe and the link",
    async (ctx) => {
      await steps.run(ctx, "teardown", async () => {
        await removeLink(owner, project);
        const gone = await owner.repositories
          .get(repository.id, { project: project.id })
          .then(
            () => "found",
            (err: unknown) =>
              err instanceof NotFoundError ? "not found" : err,
          );
        expect(gone).toBe("not found");
      });
    },
    STEP_TIMEOUT,
  );
});

/** The lane's runtime, its recipes and the repository link, found by name. */
async function removeLink(
  owner: IntrospectionClient,
  project: Project,
): Promise<void> {
  const ignore404 = (err: unknown) => {
    if (!(err instanceof NotFoundError)) throw err;
  };
  const links = await owner.repositories.list({
    project: project.id,
    slug: GITHUB.repo,
  });
  for await (const r of owner.runtimes.list({
    project: project.id,
    runtime: GITHUB.recipe,
  }))
    await owner.runtimes.delete(r.id, project.id).catch(ignore404);
  for (const link of links) {
    for await (const r of owner.recipes.list({ project: project.id }))
      if (r.repository_id === link.id)
        await owner.recipes.delete(r.id, project.id).catch(ignore404);
    await owner.repositories
      .delete(link.id, { project: project.id })
      .catch(ignore404);
  }
}
