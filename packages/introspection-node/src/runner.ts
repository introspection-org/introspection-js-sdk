import {
  RunnerExpiredError,
  type RunnerContext,
  type RunnerDeployment,
  type RunnerSpec,
  type RunRequest,
  type Uuid,
} from "@introspection-sdk/types";
import {
  ConversationsApi,
  EventsApi,
  FilesApi,
  MetricsApi,
  SharesApi,
  TasksApi,
} from "@introspection-sdk/http";
import { HttpClient } from "./http.js";
import type { IntrospectionClient } from "./client.js";

/**
 * Where this Runner came from, so `refresh()` can call CP again with the
 * same arguments to obtain a fresh `RunnerSpec` (manual escape hatch only;
 * not auto-scheduled).
 */
export type RunnerSource =
  | { kind: "runtime"; id: Uuid; options?: RunRequest }
  | { kind: "experiment"; id: Uuid; options?: RunRequest };

/**
 * Live handle to a Data Plane sandbox. Holds the bearer JWT, the DP
 * endpoint URL, and the runtime/experiment context, and exposes the
 * runner-bound `tasks`, `files`, `conversations`, `events`, and
 * `metrics` namespaces (the telemetry reads are Data-Plane-scoped and so
 * hang off the runner, which carries the DP bearer + `events:read`).
 *
 * In v1 of the agent-session-based design, token refresh is handled
 * server-side by the DP materializer attached to the agent session — the
 * SDK does NOT auto-refresh and does NOT install a 401 safety-net. The
 * `refresh()` method is kept as a manual escape hatch that re-calls the
 * CP `/run` route to mint a brand-new spec.
 */
export class Runner {
  private spec: RunnerSpec;
  private http: HttpClient;
  private closed = false;

  // Public API surfaces.
  readonly tasks: TasksApi;
  readonly files: FilesApi;
  readonly conversations: ConversationsApi;
  readonly events: EventsApi;
  readonly metrics: MetricsApi;
  readonly shares: SharesApi;

  constructor(
    private readonly client: IntrospectionClient,
    private readonly source: RunnerSource,
    spec: RunnerSpec,
  ) {
    this.spec = spec;
    this.http = this.buildHttp();
    this.tasks = new TasksApi(this.guardedHttp(this.http));
    this.files = new FilesApi(this.guardedHttp(this.http));
    this.conversations = new ConversationsApi(this.guardedHttp(this.http));
    this.events = new EventsApi(this.guardedHttp(this.http));
    this.metrics = new MetricsApi(this.guardedHttp(this.http));
    this.shares = new SharesApi(this.guardedHttp(this.http));
  }

  // --- public accessors ---

  /** DP REST base URL the runner is bound to. */
  get dpEndpoint(): string {
    return this.spec.deployment.endpoint;
  }

  /** Routing target — DP endpoint / slug / region. */
  get deployment(): Readonly<RunnerDeployment> {
    return Object.freeze({ ...this.spec.deployment });
  }

  /** Session lifetime (ISO-8601 string). */
  get expires_at(): string {
    return this.spec.expires_at;
  }

  /** Session ID assigned by CP. */
  get session_id(): string {
    return this.spec.session_id;
  }

  /** Resolved runtime / arm / recipe / identity / caller context. */
  get context(): Readonly<RunnerContext> {
    return Object.freeze({ ...this.spec.runtime_context });
  }

  /** True once `close()` has been called. */
  get isClosed(): boolean {
    return this.closed;
  }

  // --- lifecycle ---

  /**
   * Manual escape hatch: re-call CP `/v1/runtimes/{id}/run` or
   * `/v1/experiments/{id}/run` with the original `RunRequest` and replace
   * this runner's in-memory spec with a fresh one.
   *
   * Not auto-scheduled — in v1 the DP materializer refreshes the
   * underlying access token transparently for the agent-session-backed
   * runner. Call this only if you have an explicit reason to mint a new
   * session (e.g. you held a runner across a very long pause).
   */
  async refresh(): Promise<void> {
    if (this.closed) {
      throw new RunnerExpiredError({
        message: "Runner has been closed",
        status: 401,
        code: "runner_expired",
      });
    }
    const fresh = await this.requestFreshSpec();
    this.spec = fresh;
    // Note: we intentionally don't swap the underlying `http` here — the
    // constructor-time bindings stay stable for the lifetime of the Runner.
    // Callers wanting a freshly-bound Runner should call
    // `client.runtime(id).run(...)` again.
  }

  /**
   * Best-effort close — flips a local `isClosed` flag so subsequent
   * `runner.tasks` / `runner.files` / `runner.conversations` calls
   * throw a friendly error. No
   * server-side revoke is performed; future work will route a revoke via
   * the CP locator-token path.
   */
  async close(): Promise<void> {
    this.closed = true;
  }

  // --- internals ---

  private buildHttp(): HttpClient {
    const advanced = this.client.advancedOptions;
    return new HttpClient({
      apiUrl: this.spec.deployment.endpoint,
      token: this.spec.session_token,
      additionalHeaders: advanced.additionalHeaders,
      fetch: advanced.fetch,
    });
  }

  /**
   * Wrap an HttpClient so that calls after `close()` fail with a clear
   * `RunnerExpiredError` instead of hitting the network with a stale
   * bearer. No 401 retry / refresh logic — that is the DP materializer's
   * job in v1.
   */
  private guardedHttp(http: HttpClient): HttpClient {
    const proxy: HttpClient = Object.create(http);
    proxy.request = async <T>(
      opts: Parameters<HttpClient["request"]>[0],
    ): Promise<T> => {
      this.assertOpen();
      return http.request<T>(opts);
    };
    proxy.stream = async (
      opts: Parameters<HttpClient["stream"]>[0],
    ): Promise<Response> => {
      this.assertOpen();
      return http.stream(opts);
    };
    return proxy;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new RunnerExpiredError({
        message: "Runner has been closed",
        status: 401,
        code: "runner_expired",
      });
    }
  }

  private async requestFreshSpec(): Promise<RunnerSpec> {
    const http = this.client.cpHttp;
    const body = toRunBody(this.source.options);
    if (this.source.kind === "runtime") {
      return await http.request<RunnerSpec>({
        method: "POST",
        path: `/v1/runtimes/${encodeURIComponent(this.source.id)}/run`,
        body,
      });
    }
    return await http.request<RunnerSpec>({
      method: "POST",
      path: `/v1/experiments/${encodeURIComponent(this.source.id)}/run`,
      body,
    });
  }
}

function toRunBody(opts?: RunRequest): Record<string, unknown> {
  if (!opts) return {};
  const out: Record<string, unknown> = {};
  if (opts.identity) out.identity = opts.identity;
  if (opts.caller) out.caller = opts.caller;
  if (opts.agent_name !== undefined) out.agent_name = opts.agent_name;
  if (opts.ttl_seconds !== undefined) out.ttl_seconds = opts.ttl_seconds;
  if (opts.scope !== undefined) out.scope = opts.scope;
  return out;
}
