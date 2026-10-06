import { AutomationsApi } from "@introspection-sdk/http";
import type { HttpClient } from "../http.js";

export { AutomationsApi };

export function attachAutomations(http: HttpClient): AutomationsApi {
  return new AutomationsApi(http);
}
