/**
 * `@introspection-sdk/http` — the isomorphic HTTP core shared by the
 * Introspection browser and Node SDKs.
 *
 * Strictly fetch + SSE: no Node built-ins, no OpenTelemetry, nothing that
 * can't be bundled into a browser. The only thing each SDK supplies on
 * top is a {@link Transport} (bearer header vs session cookie) — see
 * {@link BaseHttpClient}.
 */

export { stripTrailingSlash, joinUrl, buildQuery } from "./url.js";
export { toApiError } from "./errors.js";
export { parseSse } from "./sse.js";
export { Paginator, cursorPaginate, type PageSource } from "./pagination.js";
export {
  BaseHttpClient,
  type BaseHttpConfig,
  type Transport,
} from "./client.js";
export type { ResourceHttpClient } from "./resources/types.js";
export {
  RunHandle,
  TaskRunsApi,
  TaskRunsClient,
  TasksApi,
  TasksClient,
} from "./resources/tasks.js";
export type { StartParams, TaskBodyMapper } from "./resources/tasks.js";
export {
  FileVersionsApi,
  FileVersionsClient,
  FilesApi,
  FilesClient,
} from "./resources/files.js";
export type { FileUploadBody } from "./resources/files.js";
export {
  ConversationItemsApi,
  ConversationItemsClient,
  ConversationsApi,
  ConversationsClient,
} from "./resources/conversations.js";
export { SharesApi, SharesClient } from "./resources/shares.js";
export {
  RuntimeHandle,
  RuntimesApi,
  RuntimesClient,
  attachRuntimes,
  isUuid,
} from "./resources/runtimes.js";
export type {
  RuntimeHandleFactory,
  RuntimeRunRequestBody,
  RuntimeRunnerFactory,
  RuntimeRunnerSource,
} from "./resources/runtimes.js";
