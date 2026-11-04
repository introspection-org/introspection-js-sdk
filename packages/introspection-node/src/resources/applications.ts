import type {
  Application,
  ApplicationCreateParams,
  ApplicationIdp,
  ApplicationIdpCreateParams,
  ApplicationKey,
  ApplicationListParams,
  ApplicationSecret,
  ApplicationSecretCreateParams,
  ApplicationUpdateParams,
  CursorParams,
  Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, paginateGet } from "../pagination.js";
import { ProjectScopedResource } from "./project-scoped.js";

function applicationPath(applicationId: Uuid, child: string): string {
  return `/v1/applications/${encodeURIComponent(applicationId)}/${child}`;
}

/** `/v1/applications/{id}/idps`: the identity providers an Application brokers. */
export class ApplicationIdpsApi {
  constructor(private readonly http: HttpClient) {}

  list(
    applicationId: Uuid,
    params: CursorParams = {},
  ): Paginator<ApplicationIdp> {
    return paginateGet<ApplicationIdp>(
      this.http,
      applicationPath(applicationId, "idps"),
      params,
      params.next,
    );
  }

  /** A `service_account` Application brokers no IdP; the API refuses it. */
  create(
    applicationId: Uuid,
    params: ApplicationIdpCreateParams,
  ): Promise<ApplicationIdp> {
    return this.http.request<ApplicationIdp>({
      method: "POST",
      path: applicationPath(applicationId, "idps"),
      body: params,
    });
  }

  delete(applicationId: Uuid, idpId: Uuid): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: applicationPath(applicationId, `idps/${encodeURIComponent(idpId)}`),
      expect: "empty",
    });
  }
}

/** `/v1/applications/{id}/secrets`: a confidential Application's client secrets. */
export class ApplicationSecretsApi {
  constructor(private readonly http: HttpClient) {}

  /** No plaintext: `secret` is returned by {@link create} only. */
  list(
    applicationId: Uuid,
    params: CursorParams = {},
  ): Paginator<ApplicationSecret> {
    return paginateGet<ApplicationSecret>(
      this.http,
      applicationPath(applicationId, "secrets"),
      params,
      params.next,
    );
  }

  /** The plaintext is in `secret` on this response only. */
  create(
    applicationId: Uuid,
    params: ApplicationSecretCreateParams = {},
  ): Promise<ApplicationSecret> {
    return this.http.request<ApplicationSecret>({
      method: "POST",
      path: applicationPath(applicationId, "secrets"),
      body: params,
    });
  }

  /** Disable a secret now, or after `expiresIn` seconds for a rotation. */
  delete(
    applicationId: Uuid,
    secretId: Uuid,
    expiresIn?: number,
  ): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: applicationPath(
        applicationId,
        `secrets/${encodeURIComponent(secretId)}`,
      ),
      query: expiresIn === undefined ? undefined : { expires_in: expiresIn },
      expect: "empty",
    });
  }
}

/** `/v1/applications/{id}/keys`: a `jwks` Application's signing keys. */
export class ApplicationKeysApi {
  constructor(private readonly http: HttpClient) {}

  /** Unpaginated. */
  list(applicationId: Uuid): Promise<ApplicationKey[]> {
    return this.http.request<ApplicationKey[]>({
      method: "GET",
      path: applicationPath(applicationId, "keys"),
    });
  }

  /** Mint a key pair; the API keeps the private half. */
  create(applicationId: Uuid): Promise<ApplicationKey> {
    return this.http.request<ApplicationKey>({
      method: "POST",
      path: applicationPath(applicationId, "keys"),
    });
  }

  delete(applicationId: Uuid, keyId: Uuid): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: applicationPath(applicationId, `keys/${encodeURIComponent(keyId)}`),
      expect: "empty",
    });
  }
}

/**
 * `/v1/applications` (Control Plane): a project's OAuth clients, with the
 * identity providers each brokers under `.idps`, its client secrets under
 * `.secrets` and its signing keys under `.keys`.
 *
 * Gated on `applications:read` / `applications:write` /
 * `applications:delete`, which only an org credential carries.
 */
export class ApplicationsApi extends ProjectScopedResource<
  Application,
  ApplicationCreateParams,
  ApplicationUpdateParams,
  ApplicationListParams
> {
  readonly idps: ApplicationIdpsApi;
  readonly secrets: ApplicationSecretsApi;
  readonly keys: ApplicationKeysApi;

  constructor(http: HttpClient) {
    super(http, "/v1/applications");
    this.idps = new ApplicationIdpsApi(http);
    this.secrets = new ApplicationSecretsApi(http);
    this.keys = new ApplicationKeysApi(http);
  }
}
