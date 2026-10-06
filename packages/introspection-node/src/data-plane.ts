import {
  AutomationsApi,
  ConversationsApi,
  EventsApi,
  FilesApi,
  MetricsApi,
  SharesApi,
  TasksApi,
} from "@introspection-sdk/http";
import type { AppConnectionCreateParams } from "@introspection-sdk/types";
import { HttpClient, type BearerCredentials } from "./http.js";
import { AppConnectionsApi } from "./resources/app-connections.js";
import { USER_AGENT } from "./utils.js";

/**
 * Every Data Plane namespace this SDK supports. `IntrospectionClient`,
 * `Runner` and `DataPlaneClient` all implement it, so code written against
 * one runs against the others; what differs is the credential each sends,
 * and so what the server lets it do.
 *
 * The Swift, Python and Rust SDKs expose the same set.
 */
export interface DataPlaneResources {
  /** `/v1/tasks`, with `tasks.runs` for runs. */
  readonly tasks: TasksApi;
  readonly files: FilesApi;
  readonly conversations: ConversationsApi;
  readonly events: EventsApi;
  readonly metrics: MetricsApi;
  readonly shares: SharesApi;
  readonly automations: AutomationsApi;
  /** Apps members connected for themselves (`/v1/connections`). */
  readonly connections: AppConnectionsApi;
}

export interface DataPlaneClientOptions {
  /** Data Plane REST base URL (the `dp_url` a token response carries). */
  dpUrl: string;
  /** A fixed bearer token. Pass this or {@link credentials}. */
  token?: string;
  /** A renewing credential, such as `AuthClient.credentials`. */
  credentials?: BearerCredentials;
  /** Extra headers merged into every request. */
  additionalHeaders?: Record<string, string>;
  /** Custom `fetch` (for tests or non-standard runtimes). */
  fetch?: typeof fetch;
}

/**
 * The project's Data Plane surface for a caller that holds a Data Plane token
 * directly, such as a member signed in with {@link AuthClient} — rather than
 * a runner minted from a runtime through the Control Plane.
 *
 * A token that names no runtime binds each task with `runtime_id`:
 *
 * ```typescript
 * const dp = await auth.dataPlane();
 * const run = await dp.tasks.start({ prompt: "Hello", runtime_id });
 * console.log(await run.text());
 * ```
 */
export class DataPlaneClient implements DataPlaneResources {
  /** @internal */
  readonly http: HttpClient;

  readonly tasks: TasksApi;
  readonly files: FilesApi;
  readonly conversations: ConversationsApi;
  readonly shares: SharesApi;
  readonly events: EventsApi;
  readonly metrics: MetricsApi;
  /** `/v1/automations`; needs `automations:read` / `automations:write`. */
  readonly automations: AutomationsApi;
  /**
   * CRUD on `/v1/connections`, the apps members connected for themselves.
   * `create` takes the `runtime` explicitly, since this client has no
   * runtime context.
   */
  readonly connections: AppConnectionsApi<Required<AppConnectionCreateParams>>;

  constructor(options: DataPlaneClientOptions) {
    if (!options.dpUrl) throw new Error("DataPlaneClient requires a dpUrl");
    if (!options.token && !options.credentials) {
      throw new Error("DataPlaneClient requires a token or credentials");
    }
    this.http = new HttpClient({
      apiUrl: options.dpUrl,
      token: options.token ?? "",
      credentials: options.credentials,
      additionalHeaders: {
        "User-Agent": USER_AGENT,
        ...options.additionalHeaders,
      },
      fetch: options.fetch,
    });
    this.tasks = new TasksApi(this.http);
    this.files = new FilesApi(this.http);
    this.conversations = new ConversationsApi(this.http);
    this.shares = new SharesApi(this.http);
    this.events = new EventsApi(this.http);
    this.metrics = new MetricsApi(this.http);
    this.automations = new AutomationsApi(this.http);
    this.connections = new AppConnectionsApi(this.http);
  }
}
