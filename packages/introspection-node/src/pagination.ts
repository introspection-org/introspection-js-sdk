/**
 * Cursor pagination now lives in the shared `@introspection-sdk/http`
 * core so the browser and Node SDKs share one `Paginator`. Re-exported
 * here to keep the existing `./pagination.js` import path stable.
 */
export {
  Paginator,
  cursorPaginate,
  paginateGet,
} from "@introspection-sdk/http";
