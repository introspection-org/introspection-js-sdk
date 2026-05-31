/**
 * Mastra integration.
 *
 * The Mastra exporter is wired into Mastra's `observability.configs` rather
 * than globally, so this integration builds the exporter — pre-bound to the
 * `init()` token — and publishes it via `introspection.getMastraExporter()`.
 *
 * Importing `../mastra-exporter.js` (which requires `@mastra/observability`)
 * is the presence gate: a missing Mastra makes discovery skip this shim.
 */

import { IntrospectionMastraExporter } from "../mastra-exporter.js";
import type { Integration } from "./base.js";

const integration: Integration = {
  identifier: "mastra",
  setupOnce({ token, baseUrl, advanced, handles }) {
    handles.mastraExporter = new IntrospectionMastraExporter({
      token,
      baseUrl,
      additionalHeaders: advanced?.additionalHeaders,
      debug: advanced?.debug,
      advanced: advanced?.spanExporter
        ? { spanExporter: advanced.spanExporter }
        : undefined,
    });
  },
};

export default integration;
