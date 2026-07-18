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

// Machine / federated / hosted-login OAuth token helpers.
export {
  serviceAccountToken,
  tokenExchange,
  authorizationCodeToken,
} from "./auth.js";
export type {
  ServiceAccountTokenParams,
  ServiceAccountToken,
  TokenExchangeParams,
  AuthorizationCodeParams,
  OAuthToken,
} from "./auth.js";

// Configuration / event types shared with the OTel surface.
export type {
  AdvancedOptions,
  IntrospectionClientOptions,
  FeedbackOptions,
  UserTraits,
} from "./types.js";

// Runner-bound REST namespaces (runner.tasks, runner.files,
// runner.conversations) + HTTP.
export {
  ConversationItemsApi,
  ConversationsApi,
  EventsApi,
  FileVersionsApi,
  FilesApi,
  MetricsApi,
  RunHandle,
  SharesApi,
  TaskRunsApi,
  TasksApi,
} from "@introspection-sdk/http";
export { streamResumable } from "@introspection-sdk/http";
export { ArrowPages } from "@introspection-sdk/http";
export type {
  EventArrowParams,
  FileUploadBody,
  ListReadParams,
  StartParams,
  StreamOptions,
} from "@introspection-sdk/http";
export { HttpClient } from "./http.js";
export type { ResolvedApiConfig } from "./http.js";
export { EventType } from "@introspection-sdk/types";

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
  AGUIEvent,
  BaseEvent,
  Interrupt,
  Message,
  ResumeEntry,
  RunAgentInput,
  Paginated,
  ListParams,
  Task,
  TaskCreateParams,
  TaskUpdateParams,
  TaskListParams,
  TaskMode,
  TaskStatus,
  TaskRunKind,
  TaskPrompt,
  TaskRun,
  TaskRunCreateParams,
  TaskRunResumeParams,
  TaskRunResponse,
  TaskCreateResponse,
  TaskCancelResponse,
  TaskCancelOptions,
  AgentInfo,
  File,
  FileType,
  FileListParams,
  FileUpdateParams,
  FileCreateTextParams,
  Runtime,
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
  ConversationSortField,
  ConversationListParams,
  ConversationItemListParams,
  ConversationResponse,
  ConversationsMethod,
  IntrospectionMetadata,
  SpanEvent,
  SpanKind,
  SpanStatus,
  ReadFormat,
  ReadWindowParams,
  IntrospectionEventName,
  IntrospectionEventEnvelope,
  ObservationPayload,
  PatternPayload,
  PatternAssignmentPayload,
  ClusteringRunPayload,
  FeedbackPayload,
  JudgementPayload,
  ObservationEvent,
  PatternEvent,
  PatternAssignmentEvent,
  ClusteringRunEvent,
  FeedbackEvent,
  JudgementEvent,
  Event,
  UnknownEvent,
  EventForName,
  EventSortField,
  EventListParams,
  MetricView,
  MetricAggregation,
  MetricFilterOperator,
  MetricInterval,
  MetricSpec,
  MetricDimension,
  MetricFilter,
  MetricTimeDimension,
  MetricOrderBy,
  MetricHaving,
  MetricQueryConfig,
  MetricQueryRequest,
  MetricDimensionValue,
  MetricResultValue,
  MetricResultRow,
  MetricEffectiveWindow,
  MetricQueryMeta,
  MetricQueryResponse,
} from "@introspection-sdk/types";
export {
  ConversationsMethods,
  IntrospectionEventNames,
  isKnownEvent,
} from "@introspection-sdk/types";
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
