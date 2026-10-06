import {
  AutomationsApi,
  ConversationsApi,
  EventsApi,
  FilesApi,
  MetricsApi,
  SharesApi,
  TasksApi,
} from "@introspection-sdk/http";
import { HttpClient, type BearerCredentials } from "./http.js";
import { USER_AGENT } from "./utils.js";

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
export class DataPlaneClient {
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
  }
}
