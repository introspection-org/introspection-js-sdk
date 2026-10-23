/**
 * Support for the SDK end-to-end walk (introspection-cloud
 * `docs/design/sdk-end-to-end-walk.md`): the target's settings, the
 * normaliser the inline snapshots go through, the step runner, and the one
 * place a documented route the SDK is exempt from is called by hand.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import type { TestContext } from "vitest";
import type { Polly } from "@pollyjs/core";
import type { HttpClient } from "@introspection-sdk/introspection-node";
import type { PollyMode } from "../polly-setup";

export type WalkTarget = "compose" | "staging" | "production";

export interface WalkSettings {
  target: WalkTarget;
  /** Control Plane URL; the Data Plane URL comes from the token response. */
  baseApiUrl: string;
  /** The signed-in owner's Control Plane session, the walk's bootstrap credential. */
  cpSession: string;
  /**
   * The login's own project. The walk never writes to it: it only reads the
   * deployment to create its own project on.
   */
  bootstrapProjectId: string | null;
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
  projectSlug: "sdk-coverage",
  projectName: "SDK coverage",
  applicationName: "sdk-coverage-walk",
  credentialName: "WALK_SECRET",
  credentialSecret: "walk-secret-value-0001",
  variableName: "WALK_MARKER",
  variableValue: "walk-marker-7f3a",
  connectorName: "hello-mcp",
  mcpServerId: "hello-mcp",
  mcpIssuer: "https://example-server.modelcontextprotocol.io/",
  mcpEndpoint: "https://example-server.modelcontextprotocol.io/mcp",
  recipeSlug: "harbor-hello-mcp",
  runtimeSlug: "sdk-coverage-runtime",
  inputFileName: "walk-input.txt",
  inputFileText: "the walk's input file",
  outputFileName: "greeting.txt",
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
export function scriptedDirective(): string {
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
      { name: "bash", arguments: { command: "echo $WALK_MARKER" } },
    ],
  };
  return `<<SCRIPT ${JSON.stringify(directive)}>>`;
}

/** The prompt for the target's agent. */
export function prompt(settings: WalkSettings): string {
  return settings.agent === "scripted"
    ? `${WALK.instruction}\n\n${scriptedDirective()}`
    : WALK.instruction;
}

const REPLAY_SETTINGS: WalkSettings = {
  target: "compose",
  baseApiUrl: "http://localhost:8000",
  cpSession: "replay-session",
  bootstrapProjectId: null,
  deploymentId: "00000000-0000-7000-8000-000000000000",
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
  return {
    target: (env.WALK_TARGET as WalkTarget | undefined) ?? "compose",
    baseApiUrl,
    cpSession,
    bootstrapProjectId: env.INTROSPECTION_PROJECT_ID ?? file.project_id ?? null,
    deploymentId: env.INTROSPECTION_DEPLOYMENT_ID ?? file.deployment_id ?? null,
    recipeRepositoryUrl:
      env.WALK_RECIPE_DIR ??
      env.WALK_RECIPE_REPOSITORY_URL ??
      REPLAY_SETTINGS.recipeRepositoryUrl,
    recipeGitRef: env.WALK_RECIPE_GIT_REF ?? "main",
    agent: env.WALK_AGENT ?? "scripted",
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SHA = /^[0-9a-f]{40}$/i;
const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const VOLATILE_KEY =
  /(^id$|_id$|_ids$|_at$|_sha$|token$|secret$|^key$|_key$|cookie$|^url$|_url$|^slug_suffix$|^expires_in$|^client_id$)/;

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
    return value;
  }
  if (typeof value === "number" && VOLATILE_KEY.test(key)) return "[number]";
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
 * Poll `read` until `done` with recording off, so the HAR holds none of the
 * polls, then read once more with it on: that one read, in the resource's
 * terminal state, is what the recording carries (design doc §5).
 * In replay the single recorded read is all there is.
 */
export async function settled<T>(
  polly: Polly,
  mode: PollyMode,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  opts: { timeoutMs: number; intervalMs?: number; label: string },
): Promise<T> {
  if (mode !== "replay") {
    // A passthrough rule over everything for the polling window; `pause()`
    // would detach the fetch the SDK's client captured at construction.
    const window = polly.server.any().passthrough();
    try {
      const deadline = Date.now() + opts.timeoutMs;
      for (;;) {
        const value = await read();
        if (done(value)) break;
        if (Date.now() > deadline) {
          throw new Error(
            `${opts.label}: not done after ${opts.timeoutMs}ms: ${JSON.stringify(value).slice(0, 400)}`,
          );
        }
        await new Promise((resolve) =>
          setTimeout(resolve, opts.intervalMs ?? 3000),
        );
      }
    } finally {
      window.passthrough(false);
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
      if (!location && upstream && page.includes("/mock-upstream-idp/callback")) {
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
 * Push the recipe into the walk's hosted repository: a shallow clone of the
 * source (a public URL, or a checkout on disk) at `ref`, pushed to the
 * hosted `main`. The bearer travels in the
 * environment as a git config, never in argv. Live only; the git transport
 * is a subprocess the recording cannot see.
 */
export function pushRecipe(
  source: { url: string; ref: string },
  target: { url: string; bearer: string },
): string {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/sdk-walk-recipe-`);
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${target.bearer}`,
    // No credential helper from the person's own git config: the source is
    // a public URL or a local checkout, the target takes the bearer above.
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { env, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  git(
    "clone",
    "--quiet",
    "--depth",
    "1",
    "--branch",
    source.ref,
    source.url,
    dir,
  );
  const sha = git("-C", dir, "rev-parse", "HEAD");
  // The Data Plane provisions the hosted copy off the Control Plane's sync
  // lane on its own schedule, so the first push may land before it exists.
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      // Provisioning seeds the hosted copy with a first commit; the walk's
      // recipe replaces it, so the push is forced on this fresh repository.
      git("-C", dir, "push", "--quiet", "--force", target.url, "HEAD:refs/heads/main");
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
 * Whether the committed recording reaches the walk's end: a record run that
 * stopped short leaves a partial HAR, which replay must not take for the
 * contract. The teardown's last call, deleting the project, is the marker.
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
      log: { entries: { request: { method: string; url: string } }[] };
    };
    return log.log.entries.some(
      (e) =>
        e.request.method === "DELETE" &&
        /\/v1\/projects\/[^/?]+$/.test(e.request.url),
    );
  }
  return false;
}
