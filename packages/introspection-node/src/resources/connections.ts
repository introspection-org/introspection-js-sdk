import type {
  AuthorizeParams,
  Connection,
  GetTokenParams,
  GetTokenResult,
  Grant,
  GrantedGrant,
  Paginated,
  Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, cursorPaginate } from "../pagination.js";

/**
 * Connections (CP) — the concrete authorized instances a connector produces.
 *
 * Use this from a Business **backend** that calls providers directly:
 * `getToken` returns the raw token. An **in-sandbox agent** should use
 * `runner.connections.authorize` instead — there the token is materialized
 * into the session and injected at egress, never held raw.
 */
export class ConnectionsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Mint a connection token for `connector` (slug or id). Returns
   * `{ status: "granted", token, ... }`, or — for `person_authorized` — a
   * first-class `{ status: "pending", mission_id, approval_url }`. Pending is
   * a normal result, never thrown.
   *
   * → `POST /v1/oauth/connections/token`
   */
  getToken(
    connector: string,
    params: GetTokenParams = {},
  ): Promise<GetTokenResult> {
    return this.http.request<GetTokenResult>({
      method: "POST",
      path: "/v1/oauth/connections/token",
      body: { connector_id: connector, ...params },
    });
  }

  /**
   * List a connector's connection records (no token material).
   *
   * → `GET /v1/connectors/{connector}/connections`
   */
  list(
    connector: Uuid,
    params: { next?: string; limit?: number } = {},
  ): Paginator<Connection> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Connection>>({
          method: "GET",
          path: `/v1/connectors/${encodeURIComponent(connector)}/connections`,
          query: { ...params, next } as unknown as Record<string, unknown>,
        }),
      params.next,
    );
  }
}

export function attachConnections(http: HttpClient): ConnectionsApi {
  return new ConnectionsApi(http);
}

/**
 * Connections (DP) — the in-sandbox agent surface, bound to a Runner.
 *
 * `authorize` ensures a live grant for an action; the token is **not**
 * returned — it is materialized into the session and injected at egress. For
 * `oauth_stored` connectors the grant is materialized at session start, so no
 * call is needed. For `person_authorized`, `authorize` triggers the mission
 * and returns `granted` or `pending` (with a hosted `approval_url`).
 *
 * NOTE: the DP `/connections/*` routes are part of the pending session-
 * materialization work; this class defines the blessed shape.
 */
export class RunnerConnectionsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Ensure a grant for `connector`.`action`. Non-blocking: returns `pending`
   * immediately for a `person_authorized` connector awaiting approval — the
   * session never blocks. Use `waitForGrant` to block until approved.
   *
   * → `POST /connections/authorize` (DP → CP mission)
   */
  authorize(connector: string, params: AuthorizeParams): Promise<Grant> {
    return this.http.request<Grant>({
      method: "POST",
      path: "/connections/authorize",
      body: { connector, ...params },
    });
  }

  /** The grants currently live in this session. → `GET /connections` */
  list(): Promise<Grant[]> {
    return this.http.request<Grant[]>({ method: "GET", path: "/connections" });
  }

  /** Current status of a pending mission's grant. → `GET /connections/grants/{mission}` */
  grant(missionId: Uuid): Promise<Grant> {
    return this.http.request<Grant>({
      method: "GET",
      path: `/connections/grants/${encodeURIComponent(missionId)}`,
    });
  }

  /**
   * Block until a `person_authorized` grant is approved, polling the mission.
   * Throws on timeout (denial/expiry surface as a terminal non-granted grant).
   */
  async waitForGrant(
    connector: string,
    params: AuthorizeParams,
    opts: { pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<GrantedGrant> {
    const interval = opts.pollIntervalMs ?? 2000;
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    const first = await this.authorize(connector, params);
    if (first.status === "granted") return first;
    const missionId = first.mission_id;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          `connection authorization for "${connector}" timed out while pending (mission ${missionId})`,
        );
      }
      await new Promise((r) => setTimeout(r, interval));
      const g = await this.grant(missionId);
      if (g.status === "granted") return g;
    }
  }
}

export function attachRunnerConnections(
  http: HttpClient,
): RunnerConnectionsApi {
  return new RunnerConnectionsApi(http);
}
