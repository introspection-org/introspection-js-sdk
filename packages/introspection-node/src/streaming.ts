/**
 * SSE parsing now lives in the shared `@introspection-sdk/http` core so
 * the browser and Node SDKs stay byte-for-byte identical. Re-exported
 * here to keep the existing `./streaming.js` import path stable.
 */
export { parseSse } from "@introspection-sdk/http";
