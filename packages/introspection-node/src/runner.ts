import {
  RunnerExpiredError,
  type RunnerContext,
  type RunnerDeployment,
  type RunnerSpec,
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
 * Live handle to a Data Plane sandbox. Holds the bearer JWT, the DP
 * endpoint URL, and the runtime/experiment context, and exposes the
 * runner-bound `tasks`, `files`, `conversations`, `events`, and
 * `metrics` namespaces (the telemetry reads are Data-Plane-scoped and so
 * hang off the runner, which carries the DP bearer + `events:read`).
 *
 * The bearer is a self-contained Runner capability that the DP validates
 * directly.
 * To create a new or newly routed session, call `runtimes.run(...)` or
 * `experiments.run(...)` again.
 */
export class Runner {
  private readonly spec: RunnerSpec;
  private readonly http: HttpClient;
  private closed = false;

  // Public API surfaces.
  readonly tasks: TasksApi;
  readonly files: FilesApi;
  readonly conversations: ConversationsApi;
  readonly events: EventsApi;
  readonly metrics: MetricsApi;
  readonly shares: SharesApi;

  constructor(client: IntrospectionClient, spec: RunnerSpec) {
    this.spec = spec;
    const advanced = client.advancedOptions;
    this.http = new HttpClient({
      apiUrl: spec.deployment.endpoint,
      token: spec.session_token,
      additionalHeaders: advanced.additionalHeaders,
      fetch: advanced.fetch,
    });
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
   * Best-effort close — flips a local `isClosed` flag so subsequent
   * `runner.tasks` / `runner.files` / `runner.conversations` calls
   * throw a friendly error. No
   * server-side revoke is performed.
   */
  async close(): Promise<void> {
    this.closed = true;
  }

  // --- internals ---

  /**
   * Wrap an HttpClient so that calls after `close()` fail with a clear
   * `RunnerExpiredError` instead of hitting the network with a stale
   * bearer. There is no 401 retry or refresh logic.
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
}
