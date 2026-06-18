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
 *   cpUrl: "https://api.introspection.dev",
 *   // your backend mints the Introspection access token (the session's
 *   // project is derived from its claims — no projectId option needed)
 *   getToken: () => fetch("/api/introspection/token").then((r) => r.text()),
 * });
 *
 * const runner = await client.runtimes("support-agent").run({
 *   identity: { user_id: "u_42" },
 * });
 * const run = await runner.tasks.start({
 *   prompt: "Summarize my latest order",
 * });
 * for await (const ev of run.stream()) console.log(ev.event, ev.data);
 * ```
 */

export {
  IntrospectionApiClient,
  type IntrospectionApiClientOptions,
} from "./client.js";
export {
  BrowserRunner,
  Runner,
  type BrowserRunnerOwner,
  type BrowserRunnerSource,
} from "./runner.js";
export {
  BrowserRuntimesClient,
  BrowserRuntimeHandle,
  attachBrowserRuntimes,
  isUuid,
  type BrowserRuntimeHandleFactory,
  type BrowserRuntimeRunRequestBody,
} from "./runtimes.js";
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
export {
  BrowserBearerHttpClient,
  BrowserHttpClient,
  type BrowserApiHttpClient,
  type BrowserBearerHttpConfig,
  type BrowserHttpConfig,
} from "./http.js";
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
  Recipe,
  RunRequest,
  RunnerContext,
  RunnerDeployment,
  RunnerSpec,
  Runtime,
  RuntimeCreate,
  RuntimeListParams,
  RuntimeUpdate,
} from "@introspection-sdk/types";
export {
  IntrospectionAPIError,
  AuthenticationError,
  InsufficientScopeError,
  NotFoundError,
  NetworkError,
  RunnerExpiredError,
} from "@introspection-sdk/types";
