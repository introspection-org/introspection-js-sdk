import type { SchemaKey } from "@introspection-sdk/http";
import type { HttpClient } from "../http.js";

/** A namespace whose routes are plain reads of fixed paths. */
export class ReadResource {
  constructor(protected readonly http: HttpClient) {}

  /** `schema` names the response type for strict decoding ({@link SchemaKey}). */
  protected read<T>(path: string, schema?: SchemaKey<T>): Promise<T> {
    return this.http.request<T>({ method: "GET", path, schema });
  }
}
