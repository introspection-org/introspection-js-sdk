/**
 * Introspection Browser API surface — `@introspection-sdk/introspection-browser/api`.
 *
 * A cookie-authenticated client for creating and streaming Introspection
 * tasks directly from a single-page app, with no API key in the browser.
 * Separate from the package's default telemetry export so apps only pull
 * in what they use.
 *
 * The browser talks only to the Data Plane. Resolving a runtime by name
 * (a Control Plane call) stays on your backend, which hands the browser a
 * short-lived access token plus the resolved `runtime_id`.
 *
 * @example
 * ```typescript
 * import { IntrospectionApiClient } from "@introspection-sdk/introspection-browser/api";
 *
 * // Your backend returns { token, runtimeId } — it mints the access token
 * // and resolves the runtime id server-side (e.g. with the Node SDK).
 * const { token, runtimeId } = await fetch("/api/introspection/session").then(
 *   (r) => r.json(),
 * );
 *
 * const client = new IntrospectionApiClient({
 *   dpUrl: "https://dp.us.introspection.dev",
 *   getToken: () => token,
 * });
 *
 * await client.connect(); // -> intro_dp_session cookie
 * const run = await client.tasks.start({
 *   prompt: "Summarize my latest order",
 *   runtime_id: runtimeId,
 * });
 * for await (const ev of run.stream()) console.log(ev.event, ev.data);
 * ```
 */

export {
  IntrospectionApiClient,
  type IntrospectionApiClientOptions,
} from "./client.js";
export {
  TasksClient,
  TaskRunsClient,
  RunHandle,
  type CreateTaskParams,
  type StartTaskParams,
} from "./tasks.js";
export {
  ConversationItemsClient,
  ConversationsClient,
  FileVersionsClient,
  FilesClient,
  SharesClient,
  type FileUploadBody,
} from "@introspection-sdk/http";
export { BrowserHttpClient, type BrowserHttpConfig } from "./http.js";
export { parseSse } from "./sse.js";
export {
  Paginator,
  cursorPaginate,
  type PageSource,
} from "@introspection-sdk/http";

// Re-exported wire types for convenience.
export type {
  Task,
  TaskRun,
  TaskStatus,
  TaskCreateResponse,
  TaskListParams,
  TaskUpdateParams,
  TaskRunCreateParams,
  TaskCancelResponse,
  RunIdentityInput,
  Paginated,
  SseEvent,
  File,
  FileType,
  FileListParams,
  FileUpdateParams,
  FileCreateTextParams,
  ListParams,
  ConversationSummary,
  ConversationItem,
  ConversationItemList,
  ConversationListParams,
  ConversationItemListParams,
  ConversationItemInclude,
  ConversationResponse,
  ResourceShare,
  ShareResourceType,
  ShareCreateParams,
  ShareListParams,
} from "@introspection-sdk/types";
export {
  IntrospectionAPIError,
  AuthenticationError,
  InsufficientScopeError,
  NotFoundError,
  NetworkError,
  RunnerExpiredError,
} from "@introspection-sdk/types";
