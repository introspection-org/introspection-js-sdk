/**
 * Introspection Browser API surface — `@introspection-sdk/introspection-browser/api`.
 *
 * A cookie-authenticated client for creating and streaming Introspection
 * tasks directly from a single-page app, with no API key in the browser.
 * Separate from the package's default telemetry export so apps only pull
 * in what they use.
 *
 * The browser talks only to the Data Plane. The recommended broker flow uses
 * a fresh, Runtime-bound delegation for every exchange.
 *
 * @example
 * ```typescript
 * import { IntrospectionApiClient } from "@introspection-sdk/introspection-browser/api";
 *
 * const initial = await fetch("/api/introspection/delegation").then((r) =>
 *   r.json(),
 * );
 * const dpUrl = initial.deployment.endpoint;
 * let initialToken: string | undefined = initial.token;
 *
 * const client = new IntrospectionApiClient({
 *   dpUrl,
 *   auth: {
 *     kind: "delegation",
 *     getToken: async () => {
 *       if (initialToken) {
 *         const token = initialToken;
 *         initialToken = undefined;
 *         return token;
 *       }
 *       const fresh = await fetch("/api/introspection/delegation").then((r) =>
 *         r.json(),
 *       );
 *       if (fresh.deployment.endpoint !== dpUrl) {
 *         throw new Error("Runtime deployment changed; rebuild the client");
 *       }
 *       return fresh.token;
 *     },
 *   },
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
