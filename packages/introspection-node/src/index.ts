/**
 * Root entry point — REST-only surface.
 *
 * Exports `IntrospectionClient` (REST), Runner / RuntimeHandle /
 * ExperimentHandle, REST wire types, and HTTP helpers. None of these
 * touch the OpenTelemetry SDK.
 *
 * For the OTel surface (logs, span processors, instrumentors) import
 * from `@introspection-sdk/introspection-node/otel`.
 */

// REST client.
export { IntrospectionClient } from "./client.js";

// Configuration / event types shared with the OTel surface.
export type {
  AdvancedOptions,
  IntrospectionClientOptions,
  FeedbackOptions,
  UserTraits,
} from "./types.js";

// Runner-bound REST namespaces (runner.tasks, runner.files,
// runner.conversations) + HTTP/SSE.
export { TasksApi, TaskRunsApi, RunHandle } from "./runner-resources/tasks.js";
export type { StartParams } from "./runner-resources/tasks.js";
export { FilesApi, FileVersionsApi } from "./runner-resources/files.js";
export type { FileUploadBody } from "./runner-resources/files.js";
export {
  ConversationsApi,
  ConversationItemsApi,
} from "./runner-resources/conversations.js";
export { SharesApi } from "./runner-resources/shares.js";
export { HttpClient } from "./http.js";
export type { ResolvedApiConfig } from "./http.js";
export { parseSse } from "./streaming.js";

// Runner + CP resources.
export { Runner } from "./runner.js";
export type { RunnerSource } from "./runner.js";
export {
  RuntimesApi,
  RuntimeHandle,
  attachRuntimes,
  isUuid,
} from "./resources/runtimes.js";
export type { RuntimeHandleFactory } from "./resources/runtimes.js";
export {
  ExperimentsApi,
  ExperimentHandle,
  attachExperiments,
} from "./resources/experiments.js";
export type { ExperimentHandleFactory } from "./resources/experiments.js";
export { RecipesApi, attachRecipes } from "./resources/recipes.js";

// REST API wire types
export type {
  Paginated,
  ListParams,
  Task,
  TaskCreateParams,
  TaskUpdateParams,
  TaskListParams,
  TaskMode,
  TaskStatus,
  TaskPrompt,
  TaskRun,
  TaskRunCreateParams,
  TaskRunResponse,
  TaskCreateResponse,
  TaskCancelResponse,
  AgentInfo,
  File,
  FileType,
  FileListParams,
  FileUpdateParams,
  FileCreateTextParams,
  SseEvent,
  Runtime,
  RuntimeCreate,
  RuntimeUpdate,
  RuntimeListParams,
  Experiment,
  ExperimentCreate,
  ExperimentUpdate,
  ExperimentListParams,
  ExperimentStatus,
  ExperimentEndParams,
  Arm,
  Recipe,
  RecipeCreate,
  RecipeUpdate,
  RecipeListParams,
  RunnerSpec,
  RunnerDeployment,
  RunnerContext,
  RunnerRecipeSummary,
  RunnerIdentity,
  RunRequest,
  RunCaller,
  RunCallerLibrary,
  RunCallerPage,
  RunIdentityInput,
  ConversationSummary,
  ConversationItem,
  ConversationItemList,
  ConversationItemInclude,
  ConversationItemNodeType,
  ConversationListParams,
  ConversationItemListParams,
  ConversationResponse,
  ConversationsMethod,
  IntrospectionMetadata,
  SpanEvent,
  SpanKind,
  SpanStatus,
} from "@introspection-sdk/types";
export { ConversationsMethods } from "@introspection-sdk/types";
export {
  IntrospectionAPIError,
  AuthenticationError,
  InsufficientScopeError,
  RunnerExpiredError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  SandboxUnavailableError,
  StreamError,
  NetworkError,
  apiErrorFromResponse,
} from "@introspection-sdk/types";

// GenAI types (shared, no OTel SDK imports).
export type {
  GenAiAttributes,
  InputMessage,
  OutputMessage,
  SystemInstruction,
  ToolDefinition,
  TextPart,
  ToolCallRequestPart,
  ToolCallResponsePart,
  CompactionPart,
  MediaUrlPart,
  BinaryDataPart,
  MessagePart,
} from "@introspection-sdk/types";
export { toAttributes } from "@introspection-sdk/types";

// OpenAI converter exports (pure functions, no OTel SDK imports).
export {
  convertResponsesInputsToSemconv,
  convertResponsesOutputsToSemconv,
  convertResponsesToolsToSemconv,
  convertResponsesInstructionsToSemconv,
} from "./converters/openai.js";
export type {
  ResponseInputItem,
  ResponseOutputItem,
  ResponseTool,
  ResponseUsage,
  Response as OpenAIResponse,
} from "./converters/openai.js";

// Gemini converters (pure functions, no OTel SDK imports).
export {
  convertGeminiContentsToInputMessages,
  convertGeminiCandidatesToOutputMessages,
  convertGeminiSystemInstructionToSemconv,
  convertGeminiToolsToToolDefinitions,
} from "./converters/gemini.js";
export type {
  GeminiCandidate,
  GeminiContent,
  GeminiFunctionDeclaration,
  GeminiPart,
  GeminiTool,
} from "./converters/gemini.js";
