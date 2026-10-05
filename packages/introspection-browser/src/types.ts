/**
 * Re-export shared types and functions from @introspection-sdk/types
 */
export type {
  AdvancedOptions,
  IntrospectionClientOptions,
  FeedbackOptions,
  UserTraits,
  LogEventOptions,
  LogEventSeverity,
  GenAiContext,
  IdentityContext,
} from "@introspection-sdk/types";

export {
  generateEventId,
  reservedEventNamePrefix,
  toAttributeValue,
} from "@introspection-sdk/types";
