import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  HttpClient,
  ConnectorsApi,
} from "@introspection-sdk/introspection-node";
import { setupPolly } from "../polly-setup.js";

// Recorded against local Cloud backed by a real Pipedream project. Replay is offline.
const connectorId = "01a0c6c2-0a01-7416-ae78-8314918257f2";
let polly: ReturnType<typeof setupPolly>;
let api: ConnectorsApi;

beforeAll(() => {
  polly = setupPolly({ recordingName: "connectors-pipedream" });
  polly.server.any().on("beforePersist", (_req: unknown, recording: any) => {
    if (recording.response?.content?.text) {
      const response = JSON.parse(recording.response.content.text);
      if (response.authorize_url) {
        response.authorize_url = "https://pipedream.com/connect?token=REDACTED";
      }
      recording.response.content.text = JSON.stringify(response);
    }
  });
  const keyPath = process.env.SDK_CONNECTOR_TEST_KEY_FILE;
  const token = keyPath
    ? JSON.parse(readFileSync(keyPath, "utf8")).api_key
    : "replay-token";
  api = new ConnectorsApi(
    new HttpClient({ apiUrl: "http://127.0.0.1:8000", token }),
  );
});
afterAll(async () => {
  await polly.stop();
});

describe("Pipedream SDK wire contract", () => {
  it("searches the app catalogue using the typed method", async () => {
    const result = await api.listApps(connectorId, { q: "outlook", limit: 5 });
    expect(result.some((app) => app.slug === "microsoft_outlook")).toBe(true);
    expect(result.every((app) => typeof app.name === "string")).toBe(true);
  });

  it("lists only the asserted customer's accounts", async () => {
    const result = await api.listAccounts(connectorId, {
      identity_user_id: "north-pipedream-test:sdk-recording",
    });
    expect(result.accounts).toEqual([]);
    expect(result.external_user_id).toMatch(/^introspection:/);
  });

  it("authorizes for the asserted customer with app and explicit scope policy", async () => {
    const result = await api.authorize(connectorId, {
      runtime: "north",
      app: "microsoft_outlook",
      identity: { user_id: "north-pipedream-test:sdk-recording" },
      allow_progressive_scopes: false,
      return_url: "http://localhost:3000/",
    });
    expect(new URL(result.authorize_url).hostname).toBe("pipedream.com");
    expect(result.expires_in).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(result.expires_at))).toBe(false);
  });
  it("disconnects only the asserted customer's runtime app access", async () => {
    await expect(
      api.disconnectAccount(connectorId, {
        identity_user_id: "north-pipedream-test:sdk-recording",
        runtime: "north",
        app: "gmail",
      }),
    ).resolves.toBeUndefined();
  });
});
