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
} from "@introspection-sdk/types";

export type { GenAiContext, IdentityContext } from "@introspection-sdk/types";

export {
  generateEventId,
  reservedEventNamePrefix,
  toAttributeValue,
} from "@introspection-sdk/types";
