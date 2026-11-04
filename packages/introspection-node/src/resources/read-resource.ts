import type { HttpClient } from "../http.js";

/** A namespace whose routes are plain reads of fixed paths. */
export class ReadResource {
  constructor(protected readonly http: HttpClient) {}

  protected read<T>(path: string): Promise<T> {
    return this.http.request<T>({ method: "GET", path });
  }
}
