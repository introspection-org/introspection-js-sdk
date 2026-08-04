import {
  RunnerExpiredError,
  type BrowserSessionBootstrap,
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
  toRunBody,
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

/** Resource clients bound to one DP endpoint + session token. */
interface RunnerResources {
  tasks: TasksApi;
  files: FilesApi;
  conversations: ConversationsApi;
  events: EventsApi;
  metrics: MetricsApi;
  shares: SharesApi;
}

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
  private http!: HttpClient;
  private resources!: RunnerResources;
  private closed = false;

  constructor(
    private readonly client: IntrospectionClient,
    private readonly source: RunnerSource,
    spec: RunnerSpec,
  ) {
    this.spec = spec;
    this.bind();
  }

  // --- public accessors ---

  /** `/v1/tasks` operations bound to the current session. */
  get tasks(): TasksApi {
    return this.resources.tasks;
  }

  /** `/v1/files` operations bound to the current session. */
  get files(): FilesApi {
    return this.resources.files;
  }

  /** Read-only `/v1/conversations` projection bound to the current session. */
  get conversations(): ConversationsApi {
    return this.resources.conversations;
  }

  /** Typed `/v1/events` reads bound to the current session. */
  get events(): EventsApi {
    return this.resources.events;
  }

  /** Bounded `/v1/metrics` queries bound to the current session. */
  get metrics(): MetricsApi {
    return this.resources.metrics;
  }

  /** `/v1/shares` read-sharing grants bound to the current session. */
  get shares(): SharesApi {
    return this.resources.shares;
  }

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
   * Project the held spec into the wire contract an app backend hands its
   * browser frontend so the browser SDK's `IntrospectionApiClient` (with
   * `getSession`) can bootstrap a Data Plane cookie session.
   *
   * Only the contract fields are serialized — nothing else from the
   * runner's context leaks to the browser. The embedded `session_token`
   * is short-lived and must be exchanged immediately by the browser at
   * `POST {deployment.endpoint}/v1/oauth/exchange`; never store it
   * (localStorage, cookies, logs) — the exchange trades it for an
   * HttpOnly session cookie.
   */
  browserSession(): BrowserSessionBootstrap {
    this.assertOpen();
    const { identity } = this.spec.runtime_context;
    return {
      session_id: this.spec.session_id,
      session_token: this.spec.session_token,
      deployment: { endpoint: this.spec.deployment.endpoint },
      expires_at: this.spec.expires_at,
      runtime_context: {
        runtime_id: this.spec.runtime_context.runtime_id,
        identity: {
          user_id: identity.user_id ?? null,
          anonymous_id: identity.anonymous_id ?? null,
          conversation_id: identity.conversation_id ?? null,
        },
      },
    };
  }

  /**
   * Manual escape hatch: re-call CP `/v1/runtimes/{id}/run` or
   * `/v1/experiments/{id}/run` with the original `RunRequest` and replace
   * this runner's in-memory spec with a fresh one.
   *
   * The transport and every resource client (`tasks`, `files`, …) are
   * rebuilt from the fresh spec, so subsequent calls use the new
   * `deployment.endpoint` and `session_token` — a refreshed runner is
   * fully re-bound, not just re-labelled.
   *
   * Not auto-scheduled — in v1 the DP materializer refreshes the
   * underlying access token transparently for the agent-session-backed
   * runner. Call this only if you have an explicit reason to mint a new
   * session (e.g. you held a runner across a very long pause).
   */
  async refresh(): Promise<void> {
    this.assertOpen();
    const fresh = await this.requestFreshSpec();
    this.spec = fresh;
    this.bind();
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

  /** (Re)build the transport + resource clients from the current spec. */
  private bind(): void {
    this.http = this.buildHttp();
    const guarded = this.guardedHttp(this.http);
    this.resources = {
      tasks: new TasksApi(guarded),
      files: new FilesApi(guarded),
      conversations: new ConversationsApi(guarded),
      events: new EventsApi(guarded),
      metrics: new MetricsApi(guarded),
      shares: new SharesApi(guarded),
    };
  }

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
