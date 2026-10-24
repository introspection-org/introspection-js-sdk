/**
 * Support for the SDK end-to-end walk (introspection-cloud
 * `docs/design/sdk-end-to-end-walk.md`): the target's settings, the
 * normaliser the inline snapshots go through, the step runner, and the one
 * place a documented route the SDK is exempt from is called by hand.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { TestContext } from "vitest";
import {
  NotFoundError,
  type HttpClient,
} from "@introspection-sdk/introspection-node";
import type { PollyMode } from "../polly-setup";

type WalkTarget = "compose" | "staging" | "production";

export interface WalkSettings {
  target: WalkTarget;
  /** Control Plane URL; the Data Plane URL comes from the token response. */
  baseApiUrl: string;
  /** The signed-in owner's Control Plane session, the walk's bootstrap credential. */
  cpSession: string;
  /** The login's project: where the walk runs. */
  bootstrapProjectId: string | null;
  /**
   * This run's suffix, `<unix time, hex>-<random>`: every name two runs in one
   * project would contend for carries it (`walkNames`), so walks run side by
   * side, and its time lets a later run remove what a crashed one left.
   * Replay sends the recorded one.
   */
  run: string;
  dpUrl: string | null;
  /** The deployment a new project is created on; resolved from the bootstrap project when unset. */
  deploymentId: string | null;
  /** Where the recipe is cloned from: a public URL, or a checkout on disk. */
  recipeRepositoryUrl: string;
  recipeGitRef: string;
  /** The recipe agent: `scripted` on Compose, `agent` with a real model. */
  agent: string;
}

/** Fixed names, so a recording matches whatever run replays it. */
export const WALK = {
  /** Names the sibling project step 1 creates and deletes. */
  siblingSuffix: "-walk",
  /** A walk takes minutes; a run this old crashed before its teardown. */
  staleAfterSeconds: 3600,
  applicationName: "sdk-coverage-walk",
  tagName: "walk",
  apiKeyName: "walk",
  automationName: "The walk's automation",
  experimentNames: ["The walk's experiment", "The walk's cancelled experiment"],
  credentialName: "WALK_SECRET",
  credentialSecret: "walk-secret-value-0001",
  secondTurn: "Reply with the single word done.",
  variableName: "WALK_MARKER",
  variableValue: "walk-marker-7f3a",
  connectorName: "hello-mcp",
  mcpServerId: "hello-mcp",
  mcpIssuer: "https://example-server.modelcontextprotocol.io/",
  mcpEndpoint: "https://example-server.modelcontextprotocol.io/mcp",
  /**
   * The hosted repository's slug names the manifest the push versions,
   * `.introspection/hello-mcp.yaml`: the push creates the recipe, the runtime
   * group and its judges, which is the hosted-git contract.
   */
  recipeSlug: "hello-mcp",
  runtimeSlug: "hello-mcp",
  inputFileName: "walk-input.txt",
  inputFileText: "the walk's input file",
  outputFileName: "greeting.txt",
  /**
   * The access step's people: customer members keyed `user:walk-<name>`.
   * Avery makes everything; Blake is shared it directly, Casey by holding the
   * platform group tag, Emery by nothing until the project-wide share. Drew, the
   * administrator, is an application on the organisation's admin agent.
   */
  personas: {
    avery: ["group:platform"],
    blake: [],
    casey: ["group:platform"],
    emery: [],
  } as Record<"avery" | "blake" | "casey" | "emery", string[]>,
  groupTag: "group:platform",
  /** The access step's administrator: an application on the admin agent. */
  adminName: "Drew",
  personaFileName: "walk-avery-notes.txt",
  /** The branch the walk pushes and merges into the hosted repository's main. */
  changeBranch: "pr/1",
  echoMessage: "hello from the public MCP",
  echoResult: "Echo: hello from the public MCP",
  instruction:
    "Call the `echo` tool from the declared `hello-mcp` MCP server with the message " +
    "`hello from the public MCP`. Write the echoed value exactly, with no quotes or " +
    "additional formatting, to `/workspace/outputs/greeting.txt`. Then run `echo $WALK_MARKER` " +
    "in the shell and reply in one short sentence.",
} as const;

/**
 * What the scripted model does on the instruction: the same three things a
 * real model does, so the judge grades both alike.
 */
function scriptedDirective(names: WalkNames): string {
  const directive = {
    reply:
      "Echoed the message through hello-mcp and wrote it to the outputs file.",
    tools: [
      { name: "hello-mcp_echo", arguments: { message: WALK.echoMessage } },
      {
        name: "write",
        arguments: {
          path: `/workspace/outputs/${WALK.outputFileName}`,
          content: WALK.echoResult,
        },
      },
      { name: "bash", arguments: { command: `echo $${names.variableName}` } },
    ],
  };
  return `<<SCRIPT ${JSON.stringify(directive)}>>`;
}

/** The prompt for the target's agent. */
export function prompt(settings: WalkSettings): string {
  const names = walkNames(settings.run);
  return settings.agent === "scripted"
    ? `${names.instruction}\n\n${scriptedDirective(names)}`
    : names.instruction;
}

/** A new run's suffix: its time, so a crashed run can be told apart, and a random tail. */
function newRun(): string {
  return `${Math.floor(Date.now() / 1000).toString(16)}-${randomBytes(2).toString("hex")}`;
}

/** The names a run uses: the fixed ones, and per-run ones for whatever two runs would contend for. */
export function walkNames(run: string) {
  const env = run.toUpperCase().replace("-", "_");
  const variableName = `WALK_MARKER_${env}`;
  return {
    ...WALK,
    run,
    /** The hosted repository and its manifest, so a push always versions afresh. */
    recipeSlug: `hello-mcp-${run}`,
    runtimeSlug: `hello-mcp-${run}`,
    applicationName: `sdk-coverage-walk-${run}`,
    adminName: `Drew ${run}`,
    tagName: `walk-${run}`,
    apiKeyName: `walk-${run}`,
    automationName: `The walk's automation ${run}`,
    experimentNames: WALK.experimentNames.map((name) => `${name} ${run}`),
    credentialName: `WALK_SECRET_${env}`,
    variableName,
    inputFileName: `walk-input-${run}.txt`,
    personaFileName: `walk-avery-notes-${run}.txt`,
    instruction: WALK.instruction.replace("$WALK_MARKER", `$${variableName}`),
  };
}
export type WalkNames = ReturnType<typeof walkNames>;

const RUN_ANYWHERE = /([0-9a-f]{8})[-_]([0-9a-f]{4})/gi;

/** When the run a name carries started; `undefined` for a name no run made. */
function runBorn(name: string | null | undefined): number | undefined {
  const match = new RegExp(RUN_ANYWHERE.source, "i").exec(name ?? "");
  return match ? parseInt(match[1]!, 16) : undefined;
}

/**
 * What a cleanup takes: a name this run made, or one a run older than the
 * cutoff left (it crashed before its teardown); never a run still going.
 * Measured from this run's own time, so replay decides as the recording did.
 */
export function ownOrStale(
  run: string,
): (name: string | null | undefined) => boolean {
  const now = runBorn(run)!;
  const own = new RegExp(run.replace("-", "[-_]"), "i");
  return (name) => {
    if (!name) return false;
    if (own.test(name)) return true;
    const born = runBorn(name);
    return born !== undefined && now - born > WALK.staleAfterSeconds;
  };
}

/** A second turn that needs no tool: the scripted agent is told its reply. */
export function secondTurn(settings: WalkSettings): string {
  return settings.agent === "scripted"
    ? `${WALK.secondTurn} <<SCRIPT ${JSON.stringify({ reply: "done" })}>>`
    : WALK.secondTurn;
}

/**
 * What replay needs that no response carries: the login's project id and the
 * run's suffix. A record run writes them beside the HAR.
 */
export const BOOTSTRAP_FILE = "bootstrap.json";

function recordedBootstrap(recording = "walk"): {
  project_id?: string;
  run?: string;
} {
  const dir =
    process.env.POLLY_RECORDINGS_DIR ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../recordings");
  if (!fs.existsSync(dir)) return {};
  for (const entry of fs.readdirSync(dir)) {
    const file = `${dir}/${entry}/${BOOTSTRAP_FILE}`;
    if (entry === recording && fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf8")) as {
        project_id?: string;
        run?: string;
      };
    }
  }
  return {};
}

const REPLAY_SETTINGS: WalkSettings = {
  target: "compose",
  baseApiUrl: "http://localhost:8000",
  cpSession: "replay-session",
  bootstrapProjectId: recordedBootstrap().project_id ?? null,
  run: recordedBootstrap().run ?? "",
  dpUrl: "http://localhost:8002",
  deploymentId: null,
  recipeRepositoryUrl:
    "https://github.com/introspection-org/recipe-harbor-mcp-agent",
  recipeGitRef: "main",
  agent: "scripted",
};

/**
 * The credentials `introspection login` writes, so a signed-in person runs
 * the walk on their own stack with nothing else configured. The CI seed
 * (`make sdk-seed-project`) writes a file of the same shape.
 */
interface CredentialsFile {
  cp_url?: string;
  cp_session?: string;
  dp_url?: string;
  org_id?: string;
  project_id?: string;
  deployment_id?: string;
}

function credentialsFile(): CredentialsFile {
  const path =
    process.env.INTROSPECTION_CREDENTIALS ??
    `${os.homedir()}/.introspection/credentials.json`;
  if (!fs.existsSync(path)) return {};
  return JSON.parse(fs.readFileSync(path, "utf8")) as CredentialsFile;
}

/**
 * The target's settings: the credentials file first, the environment over
 * it. Replay needs none of them and gets fixed values.
 */
export function walkSettings(
  mode: "record" | "replay" | "passthrough",
): WalkSettings {
  if (mode === "replay") return REPLAY_SETTINGS;
  const file = credentialsFile();
  const env = process.env;
  const baseApiUrl = env.INTROSPECTION_BASE_API_URL ?? file.cp_url;
  const cpSession = env.INTROSPECTION_CP_SESSION ?? file.cp_session;
  if (!baseApiUrl || !cpSession) {
    throw new Error(
      `the walk is in ${mode} mode and has no Control Plane session: run \`introspection login\` ` +
        "or set INTROSPECTION_BASE_API_URL and INTROSPECTION_CP_SESSION",
    );
  }
  const bootstrapProjectId =
    env.INTROSPECTION_PROJECT_ID ?? file.project_id ?? null;
  if (!bootstrapProjectId) {
    throw new Error(
      "the walk runs in the login's project and the login names none: " +
        "run `introspection login` and pick a project, or set INTROSPECTION_PROJECT_ID",
    );
  }
  return {
    target: (env.WALK_TARGET as WalkTarget | undefined) ?? "compose",
    baseApiUrl,
    cpSession,
    bootstrapProjectId,
    run: newRun(),
    dpUrl: env.INTROSPECTION_DP_URL ?? file.dp_url ?? null,
    deploymentId: env.INTROSPECTION_DEPLOYMENT_ID ?? file.deployment_id ?? null,
    // The recipe the walk pushes: a checkout on disk (RECIPE_DIR) or a git
    // URL, at the head of `main` unless RECIPE_GIT_REF names another ref.
    recipeRepositoryUrl:
      env.RECIPE_DIR ??
      env.RECIPE_REPOSITORY_URL ??
      siblingRecipe() ??
      REPLAY_SETTINGS.recipeRepositoryUrl,
    recipeGitRef: env.RECIPE_GIT_REF ?? "main",
    agent: env.WALK_AGENT ?? "scripted",
  };
}

/**
 * A `recipe-harbor-mcp-agent` checkout beside this repository: the recipe is
 * private, so cloning it needs GitHub credentials a local checkout does not.
 */
function siblingRecipe(): string | undefined {
  const dir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../recipe-harbor-mcp-agent",
  );
  return fs.existsSync(`${dir}/.git`) ? dir : undefined;
}

/**
 * A UUIDv7-shaped id derived from the span an event annotates: the same on
 * every replay (the span is recorded), new on every live run, where a fixed
 * id would collide with the receipt a previous run left in the project.
 */
export function spanEventId(
  traceId: string,
  spanId: string,
  label: string,
): string {
  const bytes = createHash("sha256")
    .update(`${traceId}:${spanId}:${label}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SHA = /^[0-9a-f]{40}$/i;
const UUID_ANYWHERE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SHA_ANYWHERE = /\b[0-9a-f]{40}\b/gi;
const DIGEST_ANYWHERE = /\b[0-9a-f]{64}\b/gi;
const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MEASURED_KEY = /(_ms$|_count$|_tokens$|^max_turn$|^display_index$)/;
const VOLATILE_KEY =
  /(^id$|_at$|_sha$|token$|secret$|^key$|_key$|cookie$|^url$|_url$|^expires_in$|^client_id$|_prefix$|_suffix$|^prefix$|^key_display$|image_tag$|_image_name$|_bytes$)/;

/**
 * Everything stable, nothing volatile: ids, timestamps, hashes, tokens,
 * secrets and URLs become a placeholder naming their kind, by key and by
 * shape, so an inline snapshot pins every other field.
 */
export function stable(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => stable(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = stable(v, k);
    }
    return out;
  }
  if (typeof value === "string") {
    if (UUID.test(value)) return "[uuid]";
    if (TIMESTAMP.test(value)) return "[timestamp]";
    if (SHA.test(value)) return "[sha]";
    if (JWT.test(value)) return "[jwt]";
    if (/^https?:\/\//.test(value)) return "[url]";
    if (VOLATILE_KEY.test(key)) return "[redacted]";
    // An identifier under an `_id` key that is not a UUID (a Restate
    // invocation, a provider response id) is volatile when it carries digits;
    // a declared name such as `mcp_server_id: hello-mcp` stays.
    if (/_id$/.test(key) && /\d/.test(value)) return "[id]";
    // An id or a hash inside a longer value (a storage path, an image tag,
    // a digest) is volatile too; the text around it stays.
    // So is a run's suffix (`walkNames`), in either of its spellings.
    return value
      .replace(UUID_ANYWHERE, "[uuid]")
      .replace(DIGEST_ANYWHERE, "[digest]")
      .replace(SHA_ANYWHERE, "[sha]")
      .replace(RUN_ANYWHERE, "[run]")
      // A short commit sha, as a recipe's slug ends in; each run pushes its own commit.
      .replace(/\b[0-9a-f]{12}\b/g, "[sha]");
  }
  // A measured number (a duration, a span or call count, a token total)
  // moves between two runs of the same script; its bounds are asserted
  // beside the snapshot instead.
  if (
    typeof value === "number" &&
    (VOLATILE_KEY.test(key) || MEASURED_KEY.test(key))
  )
    return "[number]";
  return value;
}

/**
 * The walk's steps share state in order; a step after a failed one skips
 * rather than failing on its missing input, so one failure reads as one.
 */
export class Steps {
  private failed: string | null = null;

  run<T>(ctx: TestContext, name: string, body: () => Promise<T>): Promise<T> {
    if (this.failed) ctx.skip(`after ${this.failed} failed`);
    ctx.onTestFailed(() => {
      this.failed = name;
    });
    return body();
  }
}

/**
 * A documented route the SDK is exempt from today (`x-introspection.clients`
 * omits `sdk`), called through the SDK's own client so it is recorded and
 * counted like every other; see the design doc §3.
 */
export function raw(http: HttpClient) {
  return {
    get: <T>(path: string, query?: Record<string, unknown>) =>
      http.request<T>({ method: "GET", path, query }),
    post: <T>(path: string, body?: unknown, query?: Record<string, unknown>) =>
      http.request<T>({ method: "POST", path, body, query }),
    patch: <T>(path: string, body: unknown, query?: Record<string, unknown>) =>
      http.request<T>({ method: "PATCH", path, body, query }),
    delete: (path: string, query?: Record<string, unknown>) =>
      http.request<void>({ method: "DELETE", path, query, expect: "empty" }),
  };
}

/**
 * The fetch Node had before Polly patched it, for the clients that poll:
 * nothing they send is recorded, and nothing they send counts toward the
 * order in which identical recorded requests are matched.
 */
export const NATIVE_FETCH: typeof fetch = globalThis.fetch;

/**
 * Poll `poll` (a quiet client, see NATIVE_FETCH) until `done`, then `read`
 * once through the recorded client: that one read, in the resource's
 * terminal state, is what the recording carries (design doc §5). In replay
 * the single recorded read is all there is.
 */
export async function settled<T>(
  mode: PollyMode,
  read: () => Promise<T>,
  poll: () => Promise<T>,
  done: (value: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<T> {
  if (mode !== "replay") {
    const deadline = Date.now() + opts.timeoutMs;
    for (;;) {
      // A conversation reads 404 until its first spans are ingested: not
      // yet, rather than gone.
      let value: T | undefined;
      try {
        value = await poll();
      } catch (err) {
        if (!(err instanceof NotFoundError)) throw err;
      }
      if (value !== undefined && done(value)) break;
      if (Date.now() > deadline) {
        throw new Error(
          `${opts.label}: not done after ${opts.timeoutMs}ms: ${JSON.stringify(value).slice(0, 400)}`,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, opts.intervalMs ?? 3000),
      );
    }
  }
  const final = await read();
  if (!done(final))
    throw new Error(
      `${opts.label}: the recorded read is not in its terminal state`,
    );
  return final;
}

/**
 * Complete an OAuth grant the way the MCP scenario harness does: follow the
 * provider's redirects by hand, sending nothing to the provider but the
 * redirect itself, and route the registered callback host (a public name
 * that does not reach a local stack) to the Control Plane the walk talks to.
 * Works only where the provider consents without a browser (design doc §10).
 */
export async function followAuthorization(
  authorizeUrl: string,
  cp: { baseApiUrl: string; cookie: string },
  returnUrl: string,
): Promise<URL> {
  let next = authorizeUrl;
  for (let hop = 0; hop < 12; hop++) {
    const url = new URL(next);
    if (url.pathname === "/v1/oauth/connections/callback") {
      next = `${cp.baseApiUrl}${url.pathname}${url.search}`;
    }
    if (next.startsWith(returnUrl)) return new URL(next);
    const toCp = next.startsWith(cp.baseApiUrl);
    const res = await fetch(next, {
      redirect: "manual",
      headers: toCp ? { Cookie: `intro_cp_session=${cp.cookie}` } : {},
    });
    let location = res.headers.get("location");
    if (!location && res.status === 200) {
      // The MCP reference server's consent page is one "Continue" link to its
      // mock upstream IdP, which grants without a person; take the link.
      const page = await res.text();
      const link = /<a\s+href="([^"]+)"[^>]*class="btn-primary"/.exec(page);
      location = link?.[1] ?? null;
      // Its mock upstream IdP completes from a script that navigates to its
      // callback with a fixed code and the browser's user id; the walk's user
      // id is fixed too, so the grant is the same subject every run.
      const upstream = /searchParams\.set\('state',\s*'([^']+)'\)/.exec(page);
      if (
        !location &&
        upstream &&
        page.includes("/mock-upstream-idp/callback")
      ) {
        const callback = new URL("/mock-upstream-idp/callback", next);
        callback.searchParams.set("state", upstream[1]!);
        callback.searchParams.set("code", "mock-auth-code");
        callback.searchParams.set("userId", "sdk-walk-user");
        location = callback.toString();
      }
      if (!location) {
        throw new Error(
          `authorization stopped at ${url.origin}${url.pathname}: a page with no continue link: ${page.slice(0, 300)}`,
        );
      }
      next = new URL(location, next).toString();
      continue;
    }
    if (!location) {
      throw new Error(
        `authorization stopped at ${url.origin}${url.pathname} with ${res.status} and no redirect: ${(await res.text()).slice(0, 300)}`,
      );
    }
    next = new URL(location, next).toString();
  }
  throw new Error(
    "authorization did not reach the return URL within 8 redirects",
  );
}

/**
 * The recipe the walk pushes, cloned at `ref` and checked before the walk
 * creates anything: `introspection check` passes and the walk's agent is
 * there. A checkout is read at `ref`, not its working tree, since that commit
 * is what the push sends. The clone uses the person's own git config, so a
 * private recipe reads through their credential helper. Live only.
 */
export function prepareRecipe(
  source: { url: string; ref: string },
  agent: string,
): string {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const firstLine = (err: unknown) =>
    String((err as { stderr?: Buffer }).stderr ?? err)
      .trim()
      .split("\n")[0];
  const isPath = !/^[a-z+]+:\/\/|^[^/]+@[^/]+:/.test(source.url);
  if (isPath && !fs.existsSync(source.url)) {
    throw new Error(`RECIPE_DIR=${source.url} does not exist.`);
  }
  const dir = fs.mkdtempSync(`${os.tmpdir()}/sdk-walk-recipe-`);
  try {
    execFileSync(
      "git",
      [
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--branch",
        source.ref,
        source.url,
        dir,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(
      isPath
        ? `Cannot clone ${source.ref} from RECIPE_DIR=${source.url} ` +
            `(${firstLine(err)}). It must be a git checkout with a ` +
            `${source.ref} branch; RECIPE_GIT_REF names another.`
        : `Cannot clone ${source.ref} from ${source.url} (${firstLine(err)}). ` +
            `Point RECIPE_DIR at a local checkout, e.g. ` +
            `RECIPE_DIR=~/introspection/recipe-harbor-mcp-agent, or make the ` +
            `URL readable by your git credentials.`,
    );
  }
  const from = isPath ? `RECIPE_DIR=${source.url}` : source.url;
  const agentFile = `agents/${agent}.yaml`;
  if (!fs.existsSync(path.join(dir, agentFile))) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `${from} has no ${agentFile} committed on ${source.ref}; the walk ` +
        `pushes what is committed there, not the working tree.` +
        (isPath ? ` Pull ${source.ref} (git -C ${source.url} pull).` : ""),
    );
  }
  try {
    execFileSync(
      "npx",
      [
        "-y",
        "-p",
        "@introspection-ai/cli@latest",
        "introspection",
        "check",
        "--work-dir",
        dir,
        "--non-interactive",
        "-o",
        "table",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    const out = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `The recipe from ${from} at ${source.ref} fails introspection check:\n` +
        `${out.stdout ?? ""}${out.stderr ?? ""}`.trim(),
    );
  }
  return dir;
}

/**
 * Push a recipe prepared by `prepareRecipe` to the walk's hosted `main`, then
 * remove the clone. The bearer travels in the environment as a git config,
 * never in argv. Live only; the git transport is a subprocess the recording
 * cannot see.
 */
/**
 * Make the cloned recipe this run's: the push versions every manifest in the
 * repository, and a manifest's name is its runtime group's, so the copy keeps
 * only `.introspection/hello-mcp.yaml`, renamed to the run's slug, and commits
 * that as one parentless commit. Two runs in one project then version groups
 * of their own. Live only.
 */
export function retargetRecipe(dir: string, slug: string): void {
  const manifests = path.join(dir, ".introspection");
  for (const entry of fs.readdirSync(manifests)) {
    if (/\.ya?ml$/.test(entry) && entry !== "hello-mcp.yaml") {
      fs.rmSync(path.join(manifests, entry));
    }
  }
  const manifest = fs
    .readFileSync(path.join(manifests, "hello-mcp.yaml"), "utf8")
    .replace(/^name: hello-mcp$/m, `name: ${slug}`);
  fs.rmSync(path.join(manifests, "hello-mcp.yaml"));
  fs.writeFileSync(path.join(manifests, `${slug}.yaml`), manifest);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "SDK walk",
    GIT_AUTHOR_EMAIL: "walk@example.com",
    GIT_COMMITTER_NAME: "SDK walk",
    GIT_COMMITTER_EMAIL: "walk@example.com",
  };
  // One parentless commit of the whole recipe: a hosted repository refuses a
  // push whose parent a shallow clone lacks.
  for (const args of [
    ["checkout", "--quiet", "--orphan", `walk-${slug}`],
    ["add", "--all"],
    ["commit", "--quiet", "-m", `walk: ${slug}`],
  ]) {
    execFileSync("git", ["-C", dir, ...args], { env, stdio: "ignore" });
  }
}

export function pushRecipe(
  dir: string,
  target: { url: string; bearer: string },
): string {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${target.bearer}`,
    // No credential helper for the target: it takes the bearer above.
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  const sha = git("-C", dir, "rev-parse", "HEAD");
  // The Data Plane provisions the hosted copy off the Control Plane's sync
  // lane on its own schedule, so the first push may land before it exists.
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      // Provisioning seeds the hosted copy with a first commit; the walk's
      // recipe replaces it, so the push is forced on this fresh repository.
      git(
        "-C",
        dir,
        "push",
        "--quiet",
        "--force",
        target.url,
        "HEAD:refs/heads/main",
      );
      break;
    } catch (err) {
      const text = String((err as { stderr?: Buffer }).stderr ?? err);
      if (!/not found/i.test(text) || Date.now() > deadline) throw err;
      execFileSync("sleep", ["3"]);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return sha;
}

/**
 * Push one commit on `branch`, on top of the hosted repository's `main`: the
 * change a later merge brings in. Fixed author and dates, so the commit is the
 * same on every run. Live only; the bearer travels in the environment.
 */
export function pushBranch(
  target: { url: string; bearer: string },
  branch: string,
  file: { path: string; content: string },
): void {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/sdk-walk-branch-`);
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${target.bearer}`,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
    GIT_AUTHOR_NAME: "SDK walk",
    GIT_AUTHOR_EMAIL: "walk@example.com",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "SDK walk",
    GIT_COMMITTER_EMAIL: "walk@example.com",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    git(
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--branch",
      "main",
      target.url,
      dir,
    );
    fs.writeFileSync(path.join(dir, file.path), file.content);
    git("-C", dir, "add", file.path);
    git("-C", dir, "commit", "--quiet", "-m", `walk: ${file.path}`);
    git(
      "-C",
      dir,
      "push",
      "--quiet",
      "--force",
      "origin",
      `HEAD:refs/heads/${branch}`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Whether the committed recording reaches the walk's end: a record run that
 * stopped short leaves a partial HAR, which replay must not take for the
 * contract. The teardown's last two calls are the marker.
 */
export function hasCompleteRecording(
  recordingsDir: string,
  recordingName: string,
): boolean {
  if (!fs.existsSync(recordingsDir)) return false;
  for (const entry of fs.readdirSync(recordingsDir)) {
    if (entry !== recordingName && !entry.startsWith(`${recordingName}_`)) {
      continue;
    }
    const har = `${recordingsDir}/${entry}/recording.har`;
    if (!fs.existsSync(har)) continue;
    const log = JSON.parse(fs.readFileSync(har, "utf8")) as {
      log: {
        entries: {
          request: { method: string; url: string };
          response: { status: number };
        }[];
      };
    };
    // The teardown ends reading the application it removed (404), then the
    // login's project, which stays.
    const [app, last] = log.log.entries.slice(-2);
    return (
      app?.request.method === "GET" &&
      app.response.status === 404 &&
      /\/v1\/applications\//.test(app.request.url) &&
      last?.request.method === "GET" &&
      last.response.status === 200 &&
      /\/v1\/projects\/[^/?]+$/.test(last.request.url)
    );
  }
  return false;
}
