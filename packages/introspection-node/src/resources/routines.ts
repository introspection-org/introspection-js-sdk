import { RoutinesApi } from "@introspection-sdk/http";
import type { HttpClient } from "../http.js";

export { RoutinesApi };

export function attachRoutines(http: HttpClient): RoutinesApi {
  return new RoutinesApi(http);
}
