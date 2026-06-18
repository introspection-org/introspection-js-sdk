import {
  RunnerExpiredError,
  type RunnerContext,
  type RunnerDeployment,
  type RunnerSpec,
  type RunRequest,
  type Uuid,
} from "@introspection-sdk/types";
import {
  ConversationsClient,
  FilesClient,
  SharesClient,
  TasksClient,
} from "@introspection-sdk/http";
import { BrowserBearerHttpClient } from "./http.js";

export type BrowserRunnerSource =
  | { kind: "runtime"; id: Uuid; options?: RunRequest }
  | { kind: "experiment"; id: Uuid; options?: RunRequest };

export interface BrowserRunnerOwner {
  readonly additionalHeaders?: Record<string, string>;
  readonly fetch?: typeof fetch;
  requestFreshRunnerSpec(source: BrowserRunnerSource): Promise<RunnerSpec>;
}

/**
 * Browser-side live handle to a Data Plane runner. Mirrors the Node Runner
 * shape but uses browser-safe fetch transport and CP-minted bearer tokens.
 */
export class BrowserRunner {
  private spec: RunnerSpec;
  private http: BrowserBearerHttpClient;
  private closed = false;

  readonly tasks: TasksClient;
  readonly files: FilesClient;
  readonly conversations: ConversationsClient;
  readonly shares: SharesClient;

  constructor(
    private readonly owner: BrowserRunnerOwner,
    private readonly source: BrowserRunnerSource,
    spec: RunnerSpec,
  ) {
    this.spec = spec;
    this.http = this.buildHttp(spec);
    const guarded = this.guardedHttp();
    this.tasks = new TasksClient(guarded);
    this.files = new FilesClient(guarded);
    this.conversations = new ConversationsClient(guarded);
    this.shares = new SharesClient(guarded);
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

  async refresh(): Promise<void> {
    this.assertOpen();
    const fresh = await this.owner.requestFreshRunnerSpec(this.source);
    this.spec = fresh;
    this.http = this.buildHttp(fresh);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private buildHttp(spec: RunnerSpec): BrowserBearerHttpClient {
    return new BrowserBearerHttpClient({
      apiUrl: spec.deployment.endpoint,
      token: spec.session_token,
      additionalHeaders: this.owner.additionalHeaders,
      fetch: this.owner.fetch,
    });
  }

  private guardedHttp(): BrowserBearerHttpClient {
    const proxy: BrowserBearerHttpClient = Object.create(this.http);
    proxy.request = async <T>(
      opts: Parameters<BrowserBearerHttpClient["request"]>[0],
    ): Promise<T> => {
      this.assertOpen();
      return this.http.request<T>(opts);
    };
    proxy.stream = async (
      opts: Parameters<BrowserBearerHttpClient["stream"]>[0],
    ): Promise<Response> => {
      this.assertOpen();
      return this.http.stream(opts);
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

export { BrowserRunner as Runner };
