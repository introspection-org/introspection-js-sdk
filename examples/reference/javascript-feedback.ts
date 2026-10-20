/**
 * JavaScript SDK reference: feedback and business events.
 *
 * Backs the docs' JavaScript SDK page, "Feedback" (region
 * `reference/javascript/feedback`). The region is module-level and carries
 * its import, as the docs do; the code above it supplies the `taskId` the
 * snippet takes as given.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   pnpm reference-javascript-feedback
 *
 * Optional env:
 *   INTROSPECTION_TASK_ID       - conversation to attach the feedback to
 *   INTROSPECTION_BASE_OTEL_URL - OTLP endpoint (default https://otel.introspection.dev)
 */

if (!process.env.INTROSPECTION_TOKEN) {
  console.error(
    "INTROSPECTION_TOKEN is not set: export a project API key (intro_...)",
  );
  process.exit(1);
}
const taskId = process.env.INTROSPECTION_TASK_ID ?? crypto.randomUUID();

// #region docs:reference/javascript/feedback
import { IntrospectionLogs } from "@introspection-sdk/introspection-node/otel";

const logs = new IntrospectionLogs({ serviceName: "support-app" });
logs.feedback("thumbs_down", { conversationId: taskId, comments: "Missed the refund policy", value: 0 });
logs.track("case_closed", { source: "web" });
await logs.shutdown();
// #endregion docs:reference/javascript/feedback
