import type {
  ConversationsApi,
  EventsApi,
  FilesApi,
  MetricsApi,
  SharesApi,
  TasksApi,
} from "@introspection-sdk/http";
import type { AppConnectionsApi } from "./resources/app-connections.js";
import type { AutomationsApi } from "./resources/automations.js";
import type { IssuesApi } from "./resources/issues.js";

/**
 * Every Data Plane namespace this SDK supports. `IntrospectionClient` and
 * `Runner` both implement it, so code written against one runs against the
 * other; what differs is the credential each sends, and so what the server
 * lets it do.
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
  readonly issues: IssuesApi;
  /** Apps members connected for themselves (`/v1/connections`). */
  readonly connections: AppConnectionsApi;
}
