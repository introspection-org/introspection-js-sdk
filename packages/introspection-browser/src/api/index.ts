/**
 * Introspection Browser API surface — `@introspection-sdk/introspection-browser/api`.
 *
 * A cookie-authenticated client for creating and streaming Introspection
 * tasks directly from a single-page app, with no API key in the browser.
 * Separate from the package's default telemetry export so apps only pull
 * in what they use.
 *
 * @example
 * ```typescript
 * import { IntrospectionApiClient } from "@introspection-sdk/introspection-browser/api";
 *
 * const client = new IntrospectionApiClient({
 *   dpUrl: "https://dp.us.introspection.dev",
 *   projectId: "proj_…",
 *   // your backend mints the Introspection access token
 *   getToken: () => fetch("/api/introspection/token").then((r) => r.text()),
 * });
 *
 * await client.connect(); // → intro_dp_session cookie
 * const run = await client.tasks.start({
 *   prompt: "Summarize my latest order",
 *   agent_name: "support-agent",
 *   identity: { user_id: "u_42" },
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
  FilesClient,
  FileVersionsClient,
  type FileUploadBody,
} from "./files.js";
export {
  ConversationsClient,
  ConversationItemsClient,
} from "./conversations.js";
export { SharesClient } from "./shares.js";
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
  TaskVisibility,
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
  FileCreateOptions,
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
} from "@introspection-sdk/types";
