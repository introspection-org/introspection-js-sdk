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
  TokenEndpointOptions,
} from "./auth.js";

// Native email-code sign-in (a `native` Application's end users).
export {
  AuthClient,
  EMAIL_CODE_GRANT_TYPE,
  InMemorySessionStorage,
} from "./auth-client.js";
export type {
  AuthChangeEvent,
  AuthClientOptions,
  AuthSession,
  AuthStateListener,
  SessionStorage,
} from "./auth-client.js";
export { DataPlaneClient } from "./data-plane.js";
export type { DataPlaneClientOptions } from "./data-plane.js";

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
  ImagesApi,
  MAX_COMMAND_WAIT_SECONDS,
  MetricsApi,
  RunHandle,
  SharesApi,
  TaskCommandsApi,
  TaskRunsApi,
  TasksApi,
} from "@introspection-sdk/http";
export { streamResumable } from "@introspection-sdk/http";
export {
  TranscriptAccumulator,
  foldAgui,
  foldSpans,
  mergeTranscripts,
} from "@introspection-sdk/http";
export { ArrowPages } from "@introspection-sdk/http";
export type {
  EventArrowParams,
  FileUploadBody,
  ListReadParams,
  StartParams,
  StreamOptions,
} from "@introspection-sdk/http";
export { HttpClient } from "./http.js";
export type { BearerCredentials, ResolvedApiConfig } from "./http.js";
export { EventType } from "@introspection-sdk/types";

// Runner + CP resources.
export { Runner } from "./runner.js";
export type { RunnerSource } from "./runner.js";
export {
  RuntimesApi,
  RuntimeHandle,
  attachRuntimes,
} from "./resources/runtimes.js";
export type { RuntimeHandleFactory } from "./resources/runtimes.js";
export {
  ExperimentsApi,
  ExperimentHandle,
  attachExperiments,
} from "./resources/experiments.js";
export type { ExperimentHandleFactory } from "./resources/experiments.js";
export { RecipesApi, attachRecipes } from "./resources/recipes.js";
export {
  ConnectorsApi,
  ConnectionsApi,
  attachConnectors,
} from "./resources/connectors.js";
export { MembersApi, attachMembers } from "./resources/members.js";
export { AutomationsApi, attachAutomations } from "./resources/automations.js";
export { AppConnectionsApi } from "./resources/app-connections.js";
export type { DataPlaneResources } from "./data-plane.js";
export {
  RepositoriesApi,
  attachRepositories,
} from "./resources/repositories.js";
export type { RepositoryContentsApi } from "./resources/repositories.js";
export { AnnotationsApi, attachAnnotations } from "./resources/annotations.js";
export { TagsApi, attachTags } from "./resources/tags.js";
export { ProjectsApi } from "./resources/projects.js";
export { ApiKeysApi } from "./resources/api-keys.js";
export {
  ApplicationIdpsApi,
  ApplicationKeysApi,
  ApplicationSecretsApi,
  ApplicationsApi,
} from "./resources/applications.js";
export { CredentialsApi, VariablesApi } from "./resources/runtime-settings.js";
export { EndpointsApi } from "./resources/endpoints.js";
export {
  ProjectScopedCollection,
  ProjectScopedResource,
} from "./resources/project-scoped.js";
export { IntegrationsApi } from "./resources/integrations.js";
export { JudgesApi } from "./resources/judges.js";
export { OidcApi } from "./resources/oidc.js";

// REST API wire types
// jscpd:ignore-start -- re-export list of wire type names
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
  TaskKind,
  TaskStatus,
  TaskRunKind,
  TaskPrompt,
  TaskRun,
  TaskRunCreateParams,
  TaskRunResumeParams,
  TaskRunResponse,
  TaskCreateResponse,
  TaskFileRef,
  TaskRepoRequest,
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
  ExperimentListParams,
  ExperimentStatus,
  ExperimentGoal,
  ExperimentGoalComponent,
  ExperimentGoalDirection,
  ExperimentGoalGuard,
  JudgeGoalComponent,
  TelemetryGoalComponent,
  ExperimentArm,
  Recipe,
  RecipeListParams,
  Repository,
  RepositoryProvider,
  RepositoryListParams,
  RepositoryGetParams,
  RepositoryEntry,
  RepositoryEntryType,
  RepositoryDirectory,
  RepositoryFile,
  RepositoryContent,
  RepositoryContentsParams,
  RepositoryContentGetParams,
  RepositoryCommit,
  RepositoryCommitPerson,
  RepositoryCommitFile,
  RepositoryCommitFileStatus,
  RepositoryCommitDetail,
  RepositoryCommitPage,
  RepositoryCommitsParams,
  RepositoryMerge,
  RepositoryMergeParams,
  Connector,
  ConnectorApp,
  ConnectorAppListParams,
  ConnectorAuthMode,
  ConnectorStatus,
  EntityUid,
  PolicyEntity,
  ConnectorCreateParams,
  ConnectorUpdateParams,
  ConnectorListParams,
  ConnectorAuthorizeParams,
  ConnectorAuthorizeResponse,
  ConnectorAuthorizeBinding,
  ConnectorCustomAppSearchParams,
  ConnectorClientRegistration,
  ConnectorOAuthDiscoveryResponse,
  Connection,
  ConnectionStatus,
  ConnectionSubjectType,
  ConnectionCreateSubjectType,
  ConnectionBrokerSubjectType,
  ConnectionCreateParams,
  ConnectionMissionConstraints,
  ConnectionTokenParams,
  ConnectionToken,
  ConnectionAuthorizationPending,
  ConnectionTokenResult,
  AppConnection,
  AppConnectionListParams,
  AppConnectionCreateParams,
  ConnectPage,
  AnnotationTarget,
  AnnotationState,
  AnnotationListParams,
  AnnotationMutation,
  AnnotationEventOptions,
  Tag,
  TagKind,
  TagListParams,
  TagCreate,
  AccessTagCreate,
  AnnotationTagCreate,
  TagUpdate,
  RunnerSpec,
  RunnerDeployment,
  RunnerContext,
  RunnerRecipeSummary,
  RunnerIdentity,
  Member,
  MemberType,
  MemberListParams,
  MemberCreateParams,
  BusinessMemberCreateParams,
  CustomerMemberCreateParams,
  MemberUpdateParams,
  Automation,
  AutomationKind,
  AutomationTriggerType,
  AutomationConditionType,
  AutomationExecutionStatus,
  AutomationSkipReason,
  AutomationCondition,
  AutomationMetadata,
  AutomationCreateParams,
  AutomationUpdateParams,
  AutomationListParams,
  AutomationTriggerResponse,
  RunRequest,
  RunCaller,
  RunCallerLibrary,
  RunCallerPage,
  RunIdentityInput,
  GenAiSpan,
  GenAiSpanList,
  GenAiSpanAttributes,
  GenAiSpanStatus,
  Conversation,
  ConversationAgent,
  ConversationUsage,
  ConversationCost,
  ConversationMetrics,
  ConversationRuntime,
  ConversationExperiment,
  ConversationRecipe,
  ConversationOwner,
  IntrospectionSpanAttributes,
  IntrospectionHistory,
  IntrospectionHistoryNewMessages,
  IntrospectionContains,
  SpanAttributes,
  SpanResource,
  ConversationItemInclude,
  ConversationSortField,
  ConversationListParams,
  ConversationItemListParams,
  ConversationContains,
  ConversationExportParams,
  Trajectory,
  TrajectoryRecord,
  TrajectoryToolCall,
  ConversationsMethod,
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
  AutomationTriggeredPayload,
  AutomationSkippedPayload,
  AutomationTriggeredEvent,
  AutomationSkippedEvent,
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
  ProjectRef,
  Project,
  ProjectListParams,
  ApiKey,
  ApiKeyCapability,
  ApiKeyStatus,
  ApiKeyCreated,
  ApiKeyListParams,
  ApiKeyCreateParams,
  ApiKeyUpdateParams,
  ApiKeyDeleteParams,
  ApiKeyAcknowledgement,
  Application,
  ApplicationType,
  ApplicationGrant,
  ApplicationListParams,
  ApplicationCreateParams,
  ApplicationUpdateParams,
  ApplicationIdp,
  ApplicationIdpProvider,
  ApplicationIdpStatus,
  ApplicationIdpCreateParams,
  ApplicationSecret,
  ApplicationSecretStatus,
  ApplicationSecretCreateParams,
  ApplicationKey,
  RuntimeSettingListParams,
  Credential,
  CredentialCreateParams,
  CredentialUpdateParams,
  Variable,
  VariableKind,
  VariableCreateParams,
  VariableUpdateParams,
  Integration,
  IntegrationType,
  IntegrationStatus,
  IntegrationCreateParams,
  IntegrationUpdateParams,
  Judge,
  JudgeListParams,
  JudgeUpdateParams,
  FeatureFlagValue,
  OidcMe,
  Image,
  ImageKind,
  ImageStatus,
  ImageScanStatus,
  ImageSourceKind,
  ImageListParams,
  ImageSource,
  ContextImageSource,
  MirrorImageSource,
  ImageProvenance,
  ImageCreateParams,
  TaskCommandKind,
  TaskCommandStatus,
  ExecTaskCommand,
  UploadTaskCommand,
  DownloadTaskCommand,
  TaskCommandSpec,
  TaskCommand,
  TaskCommandListParams,
  TaskCommandGetOptions,
} from "@introspection-sdk/types";
// jscpd:ignore-end
export {
  ConversationsMethods,
  IntrospectionEventNames,
  genAiConversationId,
  genAiInputMessages,
  genAiOutputMessages,
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
  NetworkError,
  StreamIncompleteError,
  RunFailedError,
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
