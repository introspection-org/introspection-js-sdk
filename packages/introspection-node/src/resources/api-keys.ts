import type {
  ApiKey,
  ApiKeyAcknowledgement,
  ApiKeyCreateParams,
  ApiKeyCreated,
  ApiKeyDeleteParams,
  ApiKeyListParams,
  ApiKeyUpdateParams,
  ProjectRef,
  Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { projectQuery } from "./project-scoped.js";

function apiKeyPath(apiKeyId: Uuid, suffix = ""): string {
  return `/v1/api-keys/${encodeURIComponent(apiKeyId)}${suffix}`;
}

/**
 * `/v1/api-keys` (Control Plane): a project's API keys.
 *
 * Gated on `api_keys:read` / `api_keys:write` / `api_keys:delete`, which only
 * an org credential (a member session or access token) carries; a project
 * API key cannot manage keys.
 */
export class ApiKeysApi {
  constructor(private readonly http: HttpClient) {}

  /** Every key of the project. The route is not paginated. */
  async list(params: ApiKeyListParams = {}): Promise<ApiKey[]> {
    const response = await this.http.request<{ api_keys: ApiKey[] }>({
      method: "GET",
      path: "/v1/api-keys",
      query: params as Record<string, unknown>,
    });
    return response.api_keys;
  }

  /**
   * Create a key. The plaintext is in `api_key` on this response and is never
   * returned again; save it, then call {@link acknowledge}.
   */
  create(
    params: ApiKeyCreateParams = {},
    project?: ProjectRef,
  ): Promise<ApiKeyCreated> {
    return this.http.request<ApiKeyCreated>({
      method: "POST",
      path: "/v1/api-keys",
      query: projectQuery(project),
      body: params,
    });
  }

  update(
    apiKeyId: Uuid,
    params: ApiKeyUpdateParams,
    project?: ProjectRef,
  ): Promise<ApiKey> {
    return this.http.request<ApiKey>({
      method: "PATCH",
      path: apiKeyPath(apiKeyId),
      query: projectQuery(project),
      body: params,
    });
  }

  /** Revoke a key now, or after `expires_in` seconds for a rotation. */
  delete(apiKeyId: Uuid, params: ApiKeyDeleteParams = {}): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: apiKeyPath(apiKeyId),
      query: params as Record<string, unknown>,
      expect: "empty",
    });
  }

  /**
   * Record that the plaintext from {@link create} was saved. A second
   * acknowledge answers 404.
   */
  acknowledge(
    apiKeyId: Uuid,
    project?: ProjectRef,
  ): Promise<ApiKeyAcknowledgement> {
    return this.http.request<ApiKeyAcknowledgement>({
      method: "POST",
      path: apiKeyPath(apiKeyId, "/acknowledge"),
      query: projectQuery(project),
    });
  }
}
