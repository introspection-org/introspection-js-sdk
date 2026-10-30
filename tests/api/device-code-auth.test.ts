/**
 * Device-code login (`DeviceCodeAuth`) and `oidcLogout`, driven against a REAL
 * in-process HTTP server: the polling loop's pending, denied and expired
 * answers, which the walk cannot reach without a person approving.
 *
 * No mocks: a `node:http` server on loopback plays the Control Plane's
 * `/v1/oauth/*` and `/v1/oidc/logout` routes, and the SDK makes real
 * round-trips to it with the global `fetch`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEVICE_CODE_GRANT_TYPE,
  DeviceCodeAuth,
  IntrospectionAPIError,
  oidcLogout,
  type DeviceCodeResponse,
} from "@introspection-sdk/introspection-node";

interface Captured {
  method: string;
  path: string;
  cookie: string | undefined;
  body: URLSearchParams;
}

type Reply = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

let server: Server;
let baseUrl: string;
let requests: Captured[] = [];
/** Answers per `METHOD /path`, taken in order; the last one repeats. */
let replies: Map<string, Reply[]>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

function on(method: string, path: string, ...answers: Reply[]): void {
  replies.set(`${method} ${path}`, answers);
}

const oauthError = (error: string): Reply => ({ status: 400, body: { error } });

const DEVICE: DeviceCodeResponse = {
  device_code: "device-secret",
  user_code: "ABCD-EFGH",
  verification_uri: "https://app.example/activate",
  verification_uri_complete: "https://app.example/activate?user_code=ABCD-EFGH",
  expires_in: 600,
  interval: 1,
};

const TOKEN = {
  access_token: "login-access",
  token_type: "Bearer",
  expires_in: 900,
  refresh_token: "login-refresh",
  session_id: "0199a000-0000-7000-8000-000000000001",
  org_id: "0199a000-0000-7000-8000-000000000002",
  cp_session: "cp-cookie",
  cp_url: "https://api.example",
  git_url: "https://git.example",
  platform_url: "https://app.example",
};

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const captured: Captured = {
      method: req.method ?? "GET",
      path: url.pathname,
      cookie: req.headers.cookie,
      body: new URLSearchParams(await readBody(req)),
    };
    requests.push(captured);
    const answers = replies.get(`${captured.method} ${captured.path}`);
    const reply = (answers?.length ?? 0) > 1 ? answers!.shift()! : answers?.[0];
    const { status, body, headers } = reply ?? {
      status: 404,
      body: { detail: "not found" },
    };
    res.writeHead(status, {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  requests = [];
  replies = new Map();
});

describe("DeviceCodeAuth", () => {
  it("starts a login as the CLI client, defaulting the poll interval", async () => {
    const { interval: _, ...withoutInterval } = DEVICE;
    on("POST", "/v1/oauth/device/code", { status: 200, body: withoutInterval });
    const auth = new DeviceCodeAuth({ baseApiUrl: `${baseUrl}/` });

    const device = await auth.requestCode({
      project: "my-project",
      capabilities: ["runtimes", "evals"],
    });

    expect(device.interval).toBe(5);
    expect(Object.fromEntries(requests[0]!.body)).toEqual({
      client_id: "cli",
      project: "my-project",
      capabilities: "runtimes,evals",
    });
  });

  it("throws the server's refusal of a device code request", async () => {
    on("POST", "/v1/oauth/device/code", oauthError("invalid_client"));
    const auth = new DeviceCodeAuth({ baseApiUrl: baseUrl, clientId: "other" });

    await expect(auth.requestCode()).rejects.toMatchObject({
      status: 400,
      code: "invalid_client",
    });
    expect(requests[0]!.body.get("client_id")).toBe("other");
  });

  it("classifies each poll answer and throws any other error", async () => {
    on(
      "POST",
      "/v1/oauth/token",
      oauthError("authorization_pending"),
      oauthError("slow_down"),
      oauthError("access_denied"),
      oauthError("expired_token"),
      { status: 200, body: TOKEN },
      oauthError("invalid_grant"),
    );
    const auth = new DeviceCodeAuth({ baseApiUrl: baseUrl });

    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await auth.pollToken("device-secret")).status);
    }
    const approved = await auth.pollToken("device-secret");
    expect(statuses).toEqual(["pending", "slow_down", "denied", "expired"]);
    expect(approved).toEqual({ status: "approved", token: TOKEN });
    await expect(auth.pollToken("device-secret")).rejects.toMatchObject({
      code: "invalid_grant",
    });
    expect(Object.fromEntries(requests[0]!.body)).toEqual({
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: "device-secret",
      client_id: "cli",
    });
  });

  it("waits through a pending poll for the approved login", async () => {
    on("POST", "/v1/oauth/token", oauthError("authorization_pending"), {
      status: 200,
      body: TOKEN,
    });
    const auth = new DeviceCodeAuth({ baseApiUrl: baseUrl });

    const token = await auth.waitForToken({ ...DEVICE, interval: 0 });

    expect(token.cp_session).toBe("cp-cookie");
    expect(requests).toHaveLength(2);
  });

  it("ends the wait when the member denies the login", async () => {
    on("POST", "/v1/oauth/token", oauthError("access_denied"));
    const auth = new DeviceCodeAuth({ baseApiUrl: baseUrl });

    const denied = await auth.waitForToken(DEVICE).catch((err: unknown) => err);

    expect(denied).toBeInstanceOf(IntrospectionAPIError);
    expect(denied).toMatchObject({ status: 400, code: "access_denied" });
  });

  it("ends the wait when the code expires, polled or not", async () => {
    on("POST", "/v1/oauth/token", oauthError("expired_token"));
    const auth = new DeviceCodeAuth({ baseApiUrl: baseUrl });

    await expect(auth.waitForToken(DEVICE)).rejects.toMatchObject({
      code: "expired_token",
    });
    await expect(
      auth.waitForToken({ ...DEVICE, expires_in: 0 }),
    ).rejects.toMatchObject({ code: "expired_token" });
    expect(requests).toHaveLength(1);
  });

  it("stops waiting when aborted", async () => {
    const auth = new DeviceCodeAuth({ baseApiUrl: baseUrl });
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled"));

    await expect(
      auth.waitForToken(DEVICE, { signal: aborted.signal }),
    ).rejects.toThrow("cancelled");

    const later = new AbortController();
    const waiting = auth.waitForToken(DEVICE, { signal: later.signal });
    later.abort(new Error("cancelled later"));
    await expect(waiting).rejects.toThrow("cancelled later");
    expect(requests).toHaveLength(0);
  });

  it("refreshes, exchanges and revokes with the login's values", async () => {
    on("POST", "/v1/oauth/token", { status: 200, body: TOKEN });
    on("POST", "/v1/oauth/revoke", {
      status: 200,
      body: { status: "revoked" },
    });
    const auth = new DeviceCodeAuth({ baseApiUrl: baseUrl });

    await auth.refresh({
      refreshToken: "login-refresh",
      sessionId: TOKEN.session_id,
      orgId: TOKEN.org_id,
    });
    await auth.developmentCredential("login-access");
    await auth.revoke({
      sessionId: TOKEN.session_id,
      orgId: TOKEN.org_id,
      token: "login-refresh",
    });
    await auth.revoke({ sessionId: TOKEN.session_id, orgId: TOKEN.org_id });

    expect(requests.map((r) => Object.fromEntries(r.body))).toEqual([
      {
        grant_type: "refresh_token",
        refresh_token: "login-refresh",
        client_id: "cli",
        session_id: TOKEN.session_id,
        org_id: TOKEN.org_id,
      },
      {
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        client_id: "cli",
        subject_token: "login-access",
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      },
      {
        client_id: "cli",
        session_id: TOKEN.session_id,
        org_id: TOKEN.org_id,
        token: "login-refresh",
      },
      { client_id: "cli", session_id: TOKEN.session_id, org_id: TOKEN.org_id },
    ]);
  });

  it("throws a refused revocation", async () => {
    on("POST", "/v1/oauth/revoke", {
      status: 400,
      body: { detail: "Invalid client_id" },
    });
    const auth = new DeviceCodeAuth({ baseApiUrl: baseUrl });

    await expect(
      auth.revoke({ sessionId: "s", orgId: "o" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("oidcLogout", () => {
  it("sends the session cookie and does not follow the redirect", async () => {
    on("GET", "/v1/oidc/logout", {
      status: 302,
      headers: { Location: "https://idp.example/end_session" },
    });

    await oidcLogout({ baseApiUrl: baseUrl, cpSession: "cp-cookie" });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.cookie).toBe("intro_cp_session=cp-cookie");
  });

  it("throws a refused sign-out", async () => {
    on("GET", "/v1/oidc/logout", {
      status: 403,
      body: { detail: "cross-site" },
    });

    await expect(
      oidcLogout({ baseApiUrl: baseUrl, cpSession: "cp-cookie" }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
