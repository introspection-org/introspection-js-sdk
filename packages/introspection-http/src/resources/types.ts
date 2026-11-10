import type { SchemaKey } from "../strict/schema-key.js";

/** One unary request, as {@link ResourceHttpClient.request} takes it. */
export interface RequestOptions<T> {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
  expect?: "json" | "empty" | "bytes" | "stream";
  signal?: AbortSignal;
  /** The response type's name, for strict decoding ({@link SchemaKey}). */
  schema?: SchemaKey<T>;
}

export interface ResourceHttpClient {
  /** Whether a response, run streams included, fails on what this SDK does not model. */
  readonly strictSchema?: boolean;

  request<T>(opts: RequestOptions<T>): Promise<T>;

  stream(opts: {
    path: string;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<Response>;
}
