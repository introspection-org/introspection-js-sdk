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
