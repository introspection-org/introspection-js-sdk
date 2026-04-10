/**
 * Introspection Browser SDK
 *
 * Provides an API for tracking events and feedback in the browser.
 *
 * @example
 * ```typescript
 * import { IntrospectionClient } from "@introspection-sdk/introspection-browser";
 *
 * const client = new IntrospectionClient({
 *   token: "intro_xxx",
 * });
 *
 * // Set identity once
 * client.identify("user_123", { email: "user@example.com" });
 *
 * // Track events
 * client.track("Button Clicked", { buttonId: "submit" });
 *
 * // Track feedback
 * client.feedback("thumbs_up", { comments: "Very helpful response" });
 * client.feedback("thumbs_down", {
 *   responseId: "msg_123",
 *   comments: "Off topic",
 * });
 * ```
 */

// Client exports
export { IntrospectionClient } from "./client.js";

// Type exports
export type {
  AdvancedOptions,
  IntrospectionClientOptions,
  FeedbackOptions,
  UserTraits,
} from "./types.js";

// Version
export { VERSION } from "./version.js";
