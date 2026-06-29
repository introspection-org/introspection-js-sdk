export interface ResourceHttpClient {
  request<T>(opts: {
    method: string;
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
    headers?: Record<string, string>;
    expect?: "json" | "empty" | "bytes" | "stream";
    signal?: AbortSignal;
  }): Promise<T>;

  stream(opts: {
    path: string;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<Response>;
}
