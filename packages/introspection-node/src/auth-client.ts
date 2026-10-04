/**
 * Native email-code sign-in for an app's end users, shaped like the Supabase
 * Auth client: `signInWithOtp`, `verifyOtp`, `getSession`, `refreshSession`,
 * `signOut` and `onAuthStateChange`.
 *
 * Requires a `native` Application. The Control Plane emails a one-time code
 * (`POST /v1/oauth/email/code`) and exchanges it at `POST /v1/oauth/token` for
 * a refreshable session of a `customer` member of the Application's
 * organization, scoped to one project and capped to the Application's
 * `allowed_scopes`. The access token is a Data Plane credential: hand the
 * session to {@link AuthClient.dataPlane}, not to `IntrospectionClient`, whose
 * Control Plane routes do not accept it.
 *
 * Federated sign-in (a `jwks` Application) keeps the session in the customer's
 * own IdP SDK; use {@link tokenExchange} for that instead.
 */
import { toApiError, stripTrailingSlash } from "@introspection-sdk/http";
import {
  AuthenticationError,
  IntrospectionAPIError,
} from "@introspection-sdk/types";
import type { OAuthToken } from "./auth.js";
import { DataPlaneClient } from "./data-plane.js";
import type { BearerCredentials } from "./http.js";

const DEFAULT_BASE_API_URL = "https://api.introspection.dev";
/** The `grant_type` of the native email-code grant. */
export const EMAIL_CODE_GRANT_TYPE =
  "urn:introspection:params:oauth:grant-type:email_code";
const GRANT_TYPE_REFRESH_TOKEN = "refresh_token";

/**
 * Where a session is kept between launches. The Web Storage shape (sync or
 * async), so a file- or keychain-backed store or any `localStorage`-like
 * object plugs in directly. Values are JSON strings.
 */
export interface SessionStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** Keeps the session in memory only; nothing survives a restart. */
export class InMemorySessionStorage implements SessionStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

/**
 * A signed-in member's session: the token response plus when it expires.
 * Field names stay on the wire (snake_case), as the token response sends them.
 */
export interface AuthSession {
  access_token: string;
  token_type: string;
  /** Rotated on every refresh. */
  refresh_token: string | null;
  /** Epoch milliseconds the access token expires at, when known. */
  expires_at: number | null;
  /** The granted scope: the Application's `allowed_scopes` ceiling. */
  scope: string | null;
  /** The platform session; refresh and sign-out are keyed on it. */
  session_id: string | null;
  org_id: string | null;
  project_id: string | null;
  /** The `customer` member the session belongs to. */
  member_id: string | null;
  /** The Data Plane URL for the session's project. */
  dp_url: string | null;
}

/** What changed, mirroring Supabase's `AuthChangeEvent`. */
export type AuthChangeEvent =
  "INITIAL_SESSION" | "SIGNED_IN" | "SIGNED_OUT" | "TOKEN_REFRESHED";

export type AuthStateListener = (
  event: AuthChangeEvent,
  session: AuthSession | null,
) => void;

export interface AuthClientOptions {
  /** The `native` Application's `client_id`. */
  clientId: string;
  /** The project the session is scoped to (slug or id). */
  project: string;
  /**
   * CP API base URL. Defaults to `INTROSPECTION_BASE_API_URL` where a
   * `process` global exists, then `https://api.introspection.dev`.
   */
  baseApiUrl?: string;
  /** Session persistence. Defaults to {@link InMemorySessionStorage}. */
  storage?: SessionStorage;
  /** Storage key; change it to keep separate sessions per environment. */
  storageKey?: string;
  /** Refresh this many seconds before expiry. Default `60`. */
  leewaySeconds?: number;
  /** Custom `fetch` (for tests or non-standard runtimes). */
  fetch?: typeof fetch;
  /** Clock in epoch milliseconds (for tests). */
  now?: () => number;
}

/** Thrown when a sign-out or a newer sign-in completes while a sign-in is pending. */
function superseded(): DOMException {
  return new DOMException(
    "A sign-out or a newer sign-in superseded this response",
    "AbortError",
  );
}

/** A rejection by the server, as opposed to a network failure that should not sign the user out. */
function isRejection(err: unknown): err is IntrospectionAPIError {
  return (
    err instanceof IntrospectionAPIError &&
    ([400, 401, 403, 422].includes(err.status) || err.code === "invalid_grant")
  );
}

function defaultBaseApiUrl(): string {
  const env =
    typeof process === "undefined"
      ? undefined
      : process.env?.INTROSPECTION_BASE_API_URL;
  return env ?? DEFAULT_BASE_API_URL;
}

/**
 * Email-code sign-in, session persistence and refresh for a `native`
 * Application.
 *
 * @example
 * ```typescript
 * const auth = new AuthClient({
 *   clientId: "intro_app_…",
 *   project: "my-project",
 *   storage: sessionStore, // getItem / setItem / removeItem
 * });
 *
 * await auth.signInWithOtp({ email });
 * // A returning user's code is 6 digits; a new user's first code is 6
 * // characters of A–Z and 0–9, so do not restrict the input to digits.
 * await auth.verifyOtp({ email, token: code });
 *
 * const dp = await auth.dataPlane();
 * const run = await dp.tasks.start({ prompt: "Hello", runtime_id });
 * ```
 */
export class AuthClient {
  private readonly baseApiUrl: string;
  private readonly storage: SessionStorage;
  private readonly storageKey: string;
  private readonly leewayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private current: AuthSession | null = null;
  /** Bumped by every sign-in and sign-out; a response read under an older value is stale. */
  private generation = 0;
  private restored = false;
  private restoring?: Promise<void>;
  private refreshing?: Promise<AuthSession>;
  private storageWrite: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<AuthStateListener>();

  constructor(private readonly options: AuthClientOptions) {
    if (!options.clientId) throw new Error("AuthClient requires a clientId");
    if (!options.project) throw new Error("AuthClient requires a project");
    this.baseApiUrl = stripTrailingSlash(
      options.baseApiUrl ?? defaultBaseApiUrl(),
    );
    this.storage = options.storage ?? new InMemorySessionStorage();
    this.storageKey = options.storageKey ?? "introspection.auth.session";
    this.leewayMs = (options.leewaySeconds ?? 60) * 1000;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error(
        "global fetch is unavailable; pass `fetch` or run on Node 18+",
      );
    }
    // Bound so a browser's native fetch is not called with this client as `this`.
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    this.now = options.now ?? Date.now;
  }

  // --- sign-in ---

  /**
   * Email a one-time code to `email`. The answer is the same whether or not
   * the email has an account; a new address gets an account on verify.
   * Throws `RateLimitError` (with `retryAfter`) when codes are requested too
   * often.
   */
  async signInWithOtp(params: { email: string }): Promise<void> {
    const res = await this.fetchImpl(`${this.baseApiUrl}/v1/oauth/email/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.options.clientId,
        email: params.email,
        project: this.options.project,
      }),
      cache: "no-store",
    });
    if (!res.ok) throw await toApiError(res);
  }

  /**
   * Verify the code sent to `email` and sign in. The code is opaque: 6 digits
   * for a returning user, 6 characters of A–Z and 0–9 for a new user's first
   * sign-in. A wrong, expired or reused code throws a `ValidationError` with
   * `code === "invalid_grant"`.
   *
   * Rejects with an `AbortError` when a sign-out or another sign-in completes
   * while the code is being verified, so a slow response never overwrites a
   * newer session.
   */
  async verifyOtp(params: {
    email: string;
    token: string;
  }): Promise<AuthSession> {
    const generation = this.generation;
    const token = await this.postToken({
      grant_type: EMAIL_CODE_GRANT_TYPE,
      client_id: this.options.clientId,
      email: params.email,
      code: params.token.trim(),
      project: this.options.project,
    });
    return this.signedIn(this.toSession(token), generation);
  }

  /** Adopt a platform token obtained elsewhere, for example from your own backend. */
  async setSession(token: OAuthToken): Promise<AuthSession> {
    return this.signedIn(this.toSession(token));
  }

  // --- session ---

  /**
   * The current session, restored from storage on first use and refreshed
   * when it is within `leewaySeconds` of expiry. `null` when signed out.
   */
  async getSession(): Promise<AuthSession | null> {
    await this.restoreIfNeeded();
    const current = this.current;
    if (!current) return null;
    if (
      current.expires_at !== null &&
      current.expires_at - this.leewayMs <= this.now()
    ) {
      return this.refreshSession();
    }
    return current;
  }

  /**
   * Renew the session now, or join the renewal already in flight. A refresh
   * the server rejects signs the user out and throws `AuthenticationError`;
   * a network failure keeps the session and rethrows.
   */
  async refreshSession(): Promise<AuthSession> {
    await this.restoreIfNeeded();
    if (this.refreshing) return this.refreshing;
    const session = this.current;
    if (!session) {
      throw new AuthenticationError({ message: "Not signed in", status: 401 });
    }
    const generation = this.generation;
    const refreshing = (async (): Promise<AuthSession> => {
      try {
        const next = await this.renew(session);
        if (this.generation !== generation) throw superseded();
        await this.store(next);
        if (this.generation !== generation) throw superseded();
        this.current = next;
        this.emit("TOKEN_REFRESHED", next);
        return next;
      } catch (err) {
        if (!isRejection(err)) throw err;
        if (this.generation !== generation) throw superseded();
        await this.clear();
        throw new AuthenticationError({
          message: `The session is no longer valid: ${err.message}`,
          status: err.status,
          code: err.code,
          requestId: err.requestId,
          body: err.body,
        });
      } finally {
        if (this.generation === generation) this.refreshing = undefined;
      }
    })();
    this.refreshing = refreshing;
    return refreshing;
  }

  /**
   * Sign out: forget the session locally, then revoke it on the platform.
   * The local session is cleared even when revocation fails; the revocation
   * error is still thrown.
   */
  async signOut(): Promise<void> {
    await this.restoreIfNeeded();
    const session = this.current;
    await this.clear();
    if (!session?.refresh_token || !session.session_id || !session.org_id) {
      return;
    }
    const res = await this.fetchImpl(`${this.baseApiUrl}/v1/oauth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.options.clientId,
        session_id: session.session_id,
        org_id: session.org_id,
      }).toString(),
      cache: "no-store",
    });
    if (!res.ok) throw await toApiError(res);
  }

  /**
   * Listen for session changes. A new listener first receives
   * `INITIAL_SESSION` with the session restored from storage (or `null`).
   */
  onAuthStateChange(listener: AuthStateListener): { unsubscribe(): void } {
    this.listeners.add(listener);
    void this.restoreIfNeeded().then(() => {
      if (this.listeners.has(listener))
        listener("INITIAL_SESSION", this.current);
    });
    return { unsubscribe: () => this.listeners.delete(listener) };
  }

  // --- using the session ---

  /**
   * A bearer credential backed by this client: refreshed before expiry, and
   * once more after a `401` unless another request already renewed it.
   */
  get credentials(): BearerCredentials {
    return {
      accessToken: async () => (await this.getSession())?.access_token ?? null,
      refreshAfterUnauthorized: async (rejected) => {
        const session = await this.getSession();
        if (!session) return false;
        if (rejected !== null && rejected !== session.access_token) return true;
        await this.refreshSession();
        return true;
      },
    };
  }

  /**
   * A Data Plane client authenticated as the signed-in member. The Data Plane
   * URL defaults to the one returned with the session.
   */
  async dataPlane(
    options: {
      dpUrl?: string;
      additionalHeaders?: Record<string, string>;
    } = {},
  ): Promise<DataPlaneClient> {
    const session = await this.getSession();
    if (!session) {
      throw new AuthenticationError({ message: "Not signed in", status: 401 });
    }
    const dpUrl = options.dpUrl ?? session.dp_url;
    if (!dpUrl) {
      throw new Error(
        "The session carries no dp_url; pass `dpUrl` for this deployment",
      );
    }
    return new DataPlaneClient({
      dpUrl,
      credentials: this.credentials,
      additionalHeaders: options.additionalHeaders,
      fetch: this.options.fetch,
    });
  }

  // --- internals ---

  private async postToken(fields: Record<string, string>): Promise<OAuthToken> {
    const res = await this.fetchImpl(`${this.baseApiUrl}/v1/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      cache: "no-store",
    });
    if (!res.ok) throw await toApiError(res);
    return (await res.json()) as OAuthToken;
  }

  /** The refresh response omits `dp_url`, so it carries over from `previous`. */
  private toSession(token: OAuthToken, previous?: AuthSession): AuthSession {
    return {
      access_token: token.access_token,
      token_type: token.token_type ?? "Bearer",
      refresh_token: token.refresh_token ?? previous?.refresh_token ?? null,
      expires_at:
        typeof token.expires_in === "number"
          ? this.now() + token.expires_in * 1000
          : null,
      scope: token.scope ?? previous?.scope ?? null,
      session_id: token.session_id ?? previous?.session_id ?? null,
      org_id: token.org_id ?? previous?.org_id ?? null,
      project_id: token.project_id ?? previous?.project_id ?? null,
      member_id: token.member_id ?? previous?.member_id ?? null,
      dp_url: token.dp_url ?? previous?.dp_url ?? null,
    };
  }

  private async renew(session: AuthSession): Promise<AuthSession> {
    if (!session.refresh_token || !session.session_id || !session.org_id) {
      throw new AuthenticationError({
        message: "The session has no refresh token",
        status: 401,
      });
    }
    const token = await this.postToken({
      grant_type: GRANT_TYPE_REFRESH_TOKEN,
      client_id: this.options.clientId,
      refresh_token: session.refresh_token,
      session_id: session.session_id,
      org_id: session.org_id,
    });
    return this.toSession(token, session);
  }

  /** `expected` is the generation read before a sign-in request was sent. */
  private async signedIn(
    session: AuthSession,
    expected?: number,
  ): Promise<AuthSession> {
    if (expected !== undefined && this.generation !== expected) {
      throw superseded();
    }
    const generation = ++this.generation;
    this.refreshing = undefined;
    this.restored = true;
    this.current = null;
    await this.store(session);
    if (this.generation !== generation) throw superseded();
    this.current = session;
    this.emit("SIGNED_IN", session);
    return session;
  }

  /** Storage may be async, so writes are chained to land in transition order. */
  private store(session: AuthSession): Promise<void> {
    const value = JSON.stringify(session);
    const write = this.storageWrite
      .catch(() => undefined)
      .then(() => this.storage.setItem(this.storageKey, value));
    this.storageWrite = write;
    return write;
  }

  private async clear(): Promise<void> {
    this.generation++;
    this.refreshing = undefined;
    const hadSession = this.current !== null;
    this.current = null;
    this.restored = true;
    if (hadSession) this.emit("SIGNED_OUT", null);
    const write = this.storageWrite
      .catch(() => undefined)
      .then(() => this.storage.removeItem(this.storageKey));
    this.storageWrite = write;
    await write.catch(() => undefined);
  }

  /** Concurrent first callers share one load, so none sees the session as absent while it is read. */
  private restoreIfNeeded(): Promise<void> {
    if (this.restored) return Promise.resolve();
    this.restoring ??= (async () => {
      let stored: AuthSession | null = null;
      try {
        const raw = await this.storage.getItem(this.storageKey);
        stored = raw ? (JSON.parse(raw) as AuthSession) : null;
      } catch {
        stored = null;
      }
      if (!this.restored && stored?.access_token) this.current = stored;
      this.restored = true;
      this.restoring = undefined;
    })();
    return this.restoring;
  }

  private emit(event: AuthChangeEvent, session: AuthSession | null): void {
    for (const listener of this.listeners) listener(event, session);
  }
}
