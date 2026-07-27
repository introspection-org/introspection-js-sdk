import {
  BaseHttpClient,
  ConversationsApi,
  EventsApi,
  FilesApi,
  MetricsApi,
  SharesApi,
  TasksApi,
  type ResourceHttpClient,
} from "@introspection-sdk/http";
import {
  RunnerExpiredError,
  type RunnerContext,
  type RunnerDeployment,
  type RunnerSpec,
} from "@introspection-sdk/types";
import { resolveBrowserFetch } from "./fetch.js";

export interface BrowserRunnerOptions {
  /** Custom `fetch` (for tests or non-standard browser runtimes). */
  fetch?: typeof fetch;
  /** Extra headers merged into every Data Plane request. */
  additionalHeaders?: Record<string, string>;
}

/**
 * Browser handle for a CP-minted Runner capability.
 *
 * Obtain the {@link RunnerSpec} from a trusted application backend. The
 * browser sends its bounded bearer directly to the selected Data Plane;
 * project-cookie authentication remains a separate concern.
 */
export class Runner {
  private closed = false;
  private readonly spec: RunnerSpec;

  readonly tasks: TasksApi;
  readonly files: FilesApi;
  readonly conversations: ConversationsApi;
  readonly events: EventsApi;
  readonly metrics: MetricsApi;
  readonly shares: SharesApi;

  private constructor(spec: RunnerSpec, options: BrowserRunnerOptions) {
    this.spec = structuredClone(spec);
    const http = new BaseHttpClient({
      apiUrl: this.spec.deployment.endpoint,
      fetch: resolveBrowserFetch(options.fetch),
      additionalHeaders: options.additionalHeaders,
      transport: {
        authHeaders: () => ({
          Authorization: `Bearer ${this.spec.session_token}`,
        }),
      },
    });
    const guarded = this.guardedHttp(http);
    this.tasks = new TasksApi(guarded);
    this.files = new FilesApi(guarded);
    this.conversations = new ConversationsApi(guarded);
    this.events = new EventsApi(guarded);
    this.metrics = new MetricsApi(guarded);
    this.shares = new SharesApi(guarded);
  }

  static fromSpec(
    spec: RunnerSpec,
    options: BrowserRunnerOptions = {},
  ): Runner {
    return new Runner(spec, options);
  }

  get dpEndpoint(): string {
    return this.spec.deployment.endpoint;
  }

  get deployment(): Readonly<RunnerDeployment> {
    return Object.freeze({ ...this.spec.deployment });
  }

  get expires_at(): string {
    return this.spec.expires_at;
  }

  get session_id(): string {
    return this.spec.session_id;
  }

  get context(): Readonly<RunnerContext> {
    return Object.freeze({ ...this.spec.runtime_context });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private guardedHttp(http: ResourceHttpClient): ResourceHttpClient {
    return {
      request: async <T>(
        opts: Parameters<ResourceHttpClient["request"]>[0],
      ) => {
        this.assertOpen();
        return http.request<T>(opts);
      },
      stream: async (
        opts: Parameters<ResourceHttpClient["stream"]>[0],
      ): Promise<Response> => {
        this.assertOpen();
        return http.stream(opts);
      },
    };
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
