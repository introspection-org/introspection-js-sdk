/**
 * What the Control Plane cannot be recorded answering, since no request or no
 * such answer exists: a wait that ends without a request, a cancelled wait, a
 * device code response that names no interval, and the request of a real
 * sign-out, which would end the walk's own session. Everything the server does
 * answer is recorded by the walk (`tests/walk/walk.test.ts`, step 19).
 *
 * A stand-in `fetch` holds the poll open: a recording replays at once, so it
 * cannot be aborted in flight.
 */
import { describe, expect, it } from "vitest";
import {
  DeviceCodeAuth,
  oidcLogout,
  type DeviceCodeResponse,
  type OAuthToken,
} from "@introspection-sdk/introspection-node";

const DEVICE: DeviceCodeResponse = {
  device_code: "device-secret",
  user_code: "ABCD-EFGH",
  verification_uri: "https://app.example/activate",
  verification_uri_complete: "https://app.example/activate?user_code=ABCD-EFGH",
  expires_in: 600,
  interval: 1,
};

const TOKEN: OAuthToken = {
  access_token: "login-access",
  token_type: "Bearer",
  expires_in: 900,
  scope: "runtimes:read",
  dp_url: "https://dp.test",
};

const NO_REQUEST = (() => {
  throw new Error("no request expected");
}) as typeof fetch;

describe("DeviceCodeAuth", () => {
  it("defaults the poll interval the server leaves out", async () => {
    const { interval: _, ...withoutInterval } = DEVICE;
    const auth = new DeviceCodeAuth({
      baseApiUrl: "https://cp.test",
      fetch: (async () => Response.json(withoutInterval)) as typeof fetch,
    });

    await expect(auth.requestCode()).resolves.toMatchObject({ interval: 5 });
  });

  it("ends the wait without a request once the code has run out", async () => {
    const auth = new DeviceCodeAuth({
      baseApiUrl: "https://cp.test",
      fetch: NO_REQUEST,
    });

    await expect(
      auth.waitForToken({ ...DEVICE, expires_in: 0 }),
    ).rejects.toMatchObject({ code: "expired_token" });
  });

  it("stops waiting between polls when aborted", async () => {
    const auth = new DeviceCodeAuth({
      baseApiUrl: "https://cp.test",
      fetch: NO_REQUEST,
    });
    const aborted = new AbortController();
    aborted.abort(new Error("cancelled"));

    await expect(
      auth.waitForToken(DEVICE, { signal: aborted.signal }),
    ).rejects.toThrow("cancelled");

    const later = new AbortController();
    const waiting = auth.waitForToken(DEVICE, { signal: later.signal });
    later.abort(new Error("cancelled later"));
    await expect(waiting).rejects.toThrow("cancelled later");
  });

  it("cancels a poll in flight", async () => {
    const wait = new AbortController();
    let polling!: () => void;
    const polled = new Promise<void>((resolve) => (polling = resolve));
    const auth = new DeviceCodeAuth({
      baseApiUrl: "https://cp.test",
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          polling();
          init.signal!.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
        })) as typeof fetch,
    });

    const waiting = auth.waitForToken(DEVICE, { signal: wait.signal });
    await polled;
    wait.abort(new Error("cancelled in flight"));

    await expect(waiting).rejects.toThrow("cancelled in flight");
  });

  it("does not return an approval that lands after the abort", async () => {
    const wait = new AbortController();
    const auth = new DeviceCodeAuth({
      baseApiUrl: "https://cp.test",
      fetch: (async () => {
        wait.abort(new Error("cancelled before the answer"));
        return Response.json(TOKEN);
      }) as typeof fetch,
    });

    await expect(
      auth.waitForToken(DEVICE, { signal: wait.signal }),
    ).rejects.toThrow("cancelled before the answer");
  });
});

describe("oidcLogout", () => {
  it("sends the session cookie and does not follow the redirect", async () => {
    let sent: RequestInit | undefined;

    await oidcLogout({
      baseApiUrl: "https://cp.test",
      cpSession: "cp-cookie",
      fetch: (async (_url: string, init: RequestInit) => {
        sent = init;
        return new Response(null, { status: 307 });
      }) as typeof fetch,
    });

    expect(sent?.redirect).toBe("manual");
    expect(sent?.headers).toEqual({ Cookie: "intro_cp_session=cp-cookie" });
  });
});
