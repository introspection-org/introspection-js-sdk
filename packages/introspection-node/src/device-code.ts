/**
 * Device-code login (OAuth 2.0 Device Authorization Grant, RFC 8628): what
 * `introspection login` runs. Request a code, show it to the member, and poll
 * the token endpoint until they approve in the browser. The login it ends
 * with is renewed with {@link DeviceCodeAuth.refresh}, traded for the
 * development credential with {@link DeviceCodeAuth.developmentCredential},
 * and ended with {@link DeviceCodeAuth.revoke} or {@link oidcLogout}.
 */
import { toApiError } from "@introspection-sdk/http";
import { IntrospectionAPIError } from "@introspection-sdk/types";
import {
  GRANT_TYPE_TOKEN_EXCHANGE,
  postTokenForm,
  resolveBaseApiUrl,
  resolveFetch,
  type OAuthToken,
  type TokenEndpointOptions,
} from "./auth.js";

/** The `grant_type` the token endpoint takes a device code under. */
export const DEVICE_CODE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";
/** The first-party CLI client, the only one the Control Plane lets start the device flow. */
export const DEVICE_FLOW_CLIENT_ID = "cli";

const GRANT_TYPE_REFRESH_TOKEN = "refresh_token";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
/** The poll interval when the server names none (RFC 8628 §3.2). */
const DEFAULT_INTERVAL_SECONDS = 5;
/** `slow_down` adds this much to the interval (RFC 8628 §3.5). */
const SLOW_DOWN_SECONDS = 5;
const MIN_INTERVAL_SECONDS = 1;
const MAX_INTERVAL_SECONDS = 60;
/** No server keeps a code alive longer; an unbounded one never times out. */
const MAX_EXPIRES_IN_SECONDS = 30 * 60;

/**
 * `POST /v1/oauth/device/code` response (RFC 8628 §3.2). Show `user_code` and
 * `verification_uri` (or open `verification_uri_complete`), then poll.
 */
export interface DeviceCodeResponse {
  /**
   * The opaque code the token endpoint is polled with. A secret: whoever
   * holds it receives the tokens once the member approves.
   */
  device_code: string;
  /** The short code the member types on the activation page. */
  user_code: string;
  /** The activation page. */
  verification_uri: string;
  /** The activation page with `user_code` already filled in. */
  verification_uri_complete: string;
  /** Seconds until `device_code` expires. */
  expires_in: number;
  /** Seconds to wait between polls; 5 when the server names none. */
  interval: number;
}

/** What to ask for in {@link DeviceCodeAuth.requestCode}. */
export interface DeviceCodeParams {
  /**
   * Project slug or id to preselect on the activation page; the member picks
   * the project when approving.
   */
  project?: string;
  /**
   * Capability bundles to limit the login to. The Control Plane intersects
   * them with the member's entitlement, so they can only narrow; an unknown
   * name is refused with `400`.
   */
  capabilities?: string[];
}

/** One poll of the token endpoint, classified (RFC 8628 §3.5). */
export type DeviceTokenPoll =
  /** The member approved: the login's tokens. */
  | { status: "approved"; token: OAuthToken }
  /** `authorization_pending`: the member has not answered yet. */
  | { status: "pending" }
  /** `slow_down`: poll less often. */
  | { status: "slow_down" }
  /** `access_denied`: the member refused the login. */
  | { status: "denied" }
  /** `expired_token`: the code ran out before the member answered. */
  | { status: "expired" };

const POLL_ERRORS: Record<string, DeviceTokenPoll["status"]> = {
  authorization_pending: "pending",
  slow_down: "slow_down",
  access_denied: "denied",
  expired_token: "expired",
};

export interface DeviceCodeAuthOptions extends TokenEndpointOptions {
  /** The client starting the flow. Defaults to {@link DEVICE_FLOW_CLIENT_ID}. */
  clientId?: string;
}

/**
 * Device-code login against the Control Plane.
 *
 * The tokens it ends with carry `cp_session` for Control Plane routes,
 * `refresh_token` / `session_id` / `org_id` for {@link refresh}, and the
 * `cp_url` / `dp_url` / `git_url` / `platform_url` the login resolved.
 *
 * @example
 * ```typescript
 * const auth = new DeviceCodeAuth();
 * const device = await auth.requestCode();
 * console.log(`Open ${device.verification_uri} and enter ${device.user_code}`);
 * const token = await auth.waitForToken(device);
 * ```
 */
export class DeviceCodeAuth {
  private readonly clientId: string;

  constructor(private readonly options: DeviceCodeAuthOptions = {}) {
    this.clientId = options.clientId ?? DEVICE_FLOW_CLIENT_ID;
  }

  /** `POST /v1/oauth/device/code`: start a login. */
  async requestCode(
    params: DeviceCodeParams = {},
  ): Promise<DeviceCodeResponse> {
    const form = new URLSearchParams({ client_id: this.clientId });
    if (params.project) form.set("project", params.project);
    if (params.capabilities?.length) {
      form.set("capabilities", params.capabilities.join(","));
    }
    const res = await resolveFetch(this.options.fetch)(
      `${resolveBaseApiUrl(this.options.baseApiUrl)}/v1/oauth/device/code`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        cache: "no-store",
      },
    );
    if (!res.ok) throw await toApiError(res);
    const device = (await res.json()) as Partial<DeviceCodeResponse>;
    return {
      ...device,
      interval: device.interval ?? DEFAULT_INTERVAL_SECONDS,
    } as DeviceCodeResponse;
  }

  /**
   * One `POST /v1/oauth/token` with the device-code grant. The four RFC 8628
   * answers come back as a {@link DeviceTokenPoll}; any other error (an
   * unknown `device_code` is `invalid_grant`) is thrown.
   */
  async pollToken(deviceCode: string): Promise<DeviceTokenPoll> {
    try {
      const token = await postTokenForm(this.options, {
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: this.clientId,
      });
      return { status: "approved", token };
    } catch (err) {
      const status =
        err instanceof IntrospectionAPIError && err.status === 400 && err.code
          ? POLL_ERRORS[err.code]
          : undefined;
      if (status) return { status } as DeviceTokenPoll;
      throw err;
    }
  }

  /**
   * Poll until the member approves, then return the login's tokens. Waits
   * `interval` between polls (bounded to 1–60 s), five seconds longer after
   * each `slow_down`. Throws an `IntrospectionAPIError` with code
   * `access_denied` when the member refuses, and one with code
   * `expired_token` when the code runs out. Abort with `signal`.
   */
  async waitForToken(
    device: DeviceCodeResponse,
    options: { signal?: AbortSignal } = {},
  ): Promise<OAuthToken> {
    const clamp = (seconds: number) =>
      Math.min(Math.max(seconds, MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS);
    let interval = clamp(device.interval);
    const deadline =
      Date.now() + Math.min(device.expires_in, MAX_EXPIRES_IN_SECONDS) * 1000;
    const expired = () =>
      new IntrospectionAPIError({
        message: "The device code expired before the login was approved",
        status: 400,
        code: "expired_token",
      });
    for (;;) {
      await sleep(interval * 1000, options.signal);
      if (Date.now() >= deadline) throw expired();
      const poll = await this.pollToken(device.device_code);
      switch (poll.status) {
        case "approved":
          return poll.token;
        case "pending":
          break;
        case "slow_down":
          interval = clamp(interval + SLOW_DOWN_SECONDS);
          break;
        case "denied":
          throw new IntrospectionAPIError({
            message: "The login was denied in the browser",
            status: 400,
            code: "access_denied",
          });
        case "expired":
          throw expired();
      }
    }
  }

  /**
   * `POST /v1/oauth/token` with the `refresh_token` grant: renew a login's
   * access token, keyed on the three values the login returned. Keep the
   * refresh token you have when the answer leaves it out. One that no longer
   * works is a `400` with code `invalid_grant`: sign in again.
   */
  refresh(params: {
    refreshToken: string;
    sessionId: string;
    orgId: string;
  }): Promise<OAuthToken> {
    return postTokenForm(this.options, {
      grant_type: GRANT_TYPE_REFRESH_TOKEN,
      refresh_token: params.refreshToken,
      client_id: this.clientId,
      session_id: params.sessionId,
      org_id: params.orgId,
    });
  }

  /**
   * `POST /v1/oauth/token` with the RFC 8693 token-exchange grant: trade a
   * login's access token for the short-lived development credential
   * `introspection dev` attaches with. Only a business member's login
   * holding `runtimes:write` and scoped to a project qualifies; any other is
   * a `400` (`unauthorized_client`, `invalid_target` or `invalid_grant`).
   */
  developmentCredential(accessToken: string): Promise<OAuthToken> {
    return postTokenForm(this.options, {
      grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
      client_id: this.clientId,
      subject_token: accessToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
    });
  }

  /**
   * `POST /v1/oauth/revoke` (RFC 7009): end a login's session, and with it
   * its refresh token. A session behind a Control Plane cookie is revoked
   * only with `token`, its refresh token or `cp_session` value. A session
   * that does not exist, or a token that does not prove it, revokes nothing
   * and still succeeds.
   */
  async revoke(params: {
    sessionId: string;
    orgId: string;
    token?: string;
  }): Promise<void> {
    const form = new URLSearchParams({
      client_id: this.clientId,
      session_id: params.sessionId,
      org_id: params.orgId,
    });
    if (params.token) form.set("token", params.token);
    const res = await resolveFetch(this.options.fetch)(
      `${resolveBaseApiUrl(this.options.baseApiUrl)}/v1/oauth/revoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        cache: "no-store",
      },
    );
    if (!res.ok) throw await toApiError(res);
  }
}

/**
 * `GET /v1/oidc/logout`: end the Control Plane session behind a `cp_session`
 * cookie (the one {@link OAuthToken.cp_session} carries), and with it the
 * session's Data Plane tokens. The first response has already revoked the
 * session; its redirect starts the browser's sign-out at the identity
 * provider, which a headless client has no use for, so it is not followed.
 * A cookie that names no live session revokes nothing and answers the same.
 */
export async function oidcLogout(
  params: TokenEndpointOptions & { cpSession: string },
): Promise<void> {
  const res = await resolveFetch(params.fetch)(
    `${resolveBaseApiUrl(params.baseApiUrl)}/v1/oidc/logout`,
    {
      redirect: "manual",
      headers: { Cookie: `intro_cp_session=${params.cpSession}` },
      cache: "no-store",
    },
  );
  if (!res.ok && (res.status < 300 || res.status >= 400)) {
    throw await toApiError(res);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
