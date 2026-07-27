/**
 * Introspection Browser API surface — `@introspection-sdk/introspection-browser/api`.
 *
 * A cookie-authenticated client for creating and streaming Introspection
 * tasks directly from a single-page app, with no API key in the browser.
 * Separate from the package's default telemetry export so apps only pull
 * in what they use.
 *
 * The browser talks only to the Data Plane. This client establishes a
 * project-wide session; Runtime selection is not part of authentication.
 *
 * @example
 * ```typescript
 * import { IntrospectionApiClient } from "@introspection-sdk/introspection-browser/api";
 *
 * // Your backend returns { token, dpUrl } — it mints the access token and
 * // surfaces the DP URL, so the browser never calls the CP.
 * const { token, dpUrl } = await fetch(
 *   "/api/introspection/session",
 * ).then((r) => r.json());
 *
 * const client = new IntrospectionApiClient({
 *   dpUrl,
 *   getToken: () => token,
 * });
 *
 * await client.connect(); // -> intro_dp_session cookie
 * const run = await client.tasks.start({
 *   prompt: "Summarize my latest order",
 * });
 * for await (const ev of run.stream()) console.log(ev.type);
 * ```
 */

export {
  IntrospectionApiClient,
  type IntrospectionApiClientOptions,
} from "./client.js";
export { Runner, type BrowserRunnerOptions } from "./runner.js";
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
export {
  Paginator,
  cursorPaginate,
  type PageSource,
} from "@introspection-sdk/http";
export { EventType } from "@introspection-sdk/types";

// Re-exported wire types for convenience.
export type {
  AGUIEvent,
  BaseEvent,
  Interrupt,
  Message,
  ResumeEntry,
  RunAgentInput,
  Task,
  TaskRun,
  TaskStatus,
  TaskRunKind,
  TaskCreateResponse,
  TaskListParams,
  TaskUpdateParams,
  TaskRunCreateParams,
  TaskRunResumeParams,
  TaskCancelResponse,
  TaskCancelOptions,
  RunnerSpec,
  RunnerDeployment,
  RunnerContext,
  RunIdentityInput,
  Paginated,
  File,
  FileType,
  FileListParams,
  FileUpdateParams,
  FileCreateTextParams,
  ListParams,
  ConversationSummary,
  ConversationSortField,
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
