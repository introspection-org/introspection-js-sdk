/**
 * The sign-in's code exchange through the real SDK against a recorded Control
 * Plane, replayed from `tests/recordings/trivia-night-login_*`. A code the
 * platform issued needs an interactive hosted login, and the token it returns
 * is a JWT the recording scrubs, so this records the exchange of a code the
 * platform never issued: the request the page sends and the refusal it gets.
 * The checks of an issued token's claims are unit tests in `scripts/test.ts`.
 * `pnpm test:login:record` records it against a LOCAL stack only, with
 * `INTROSPECTION_API_BASE_URL` and `TRIVIA_SPA_CLIENT_ID` set (`.env.local`).
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { IntrospectionAPIError } from "@introspection-sdk/introspection-node";

const RECORDING = "trivia-night-login";
const RECORDINGS = path.resolve(__dirname, "../../../tests/recordings");
const BOOTSTRAP = path.join(RECORDINGS, RECORDING, "run.json");
/** A PKCE verifier and state of the page's shape, fixed so a replay sends the recorded form. */
const FLOW = {
  verifier: "trivia-night-recorded-verifier-0123456789abcdefghij",
  state: "trivia-night-recorded-state",
};

interface Bootstrap {
  api: string;
}
/** The recording scrubs a client id like a key, so a replay may send any of that shape. */
const REPLAY_CLIENT_ID = "intro_app_replayedclientid000000000";

async function main() {
  const { getPollyMode, setupPolly } =
    await import("../../../tests/polly-setup");
  if (getPollyMode() === "record") {
    const api = process.env.INTROSPECTION_API_BASE_URL ?? "";
    if (!/^http:\/\/localhost:/.test(api))
      throw new Error("record against a local stack only");
    mkdirSync(path.dirname(BOOTSTRAP), { recursive: true });
    const bootstrap: Bootstrap = { api };
    writeFileSync(BOOTSTRAP, `${JSON.stringify(bootstrap, null, 2)}\n`);
  }
  const bootstrap = JSON.parse(readFileSync(BOOTSTRAP, "utf8")) as Bootstrap;
  const polly = setupPolly({ recordingName: RECORDING, ordered: true });
  try {
    const login = await import("../lib/session");
    const callback = {
      code: "a-code-the-platform-never-issued",
      state: FLOW.state,
      cookie: JSON.stringify(FLOW),
      redirectUri: "http://localhost:3500/callback",
      clientId:
        getPollyMode() === "record"
          ? (process.env.TRIVIA_SPA_CLIENT_ID ?? "")
          : REPLAY_CLIENT_ID,
      cpUrl: bootstrap.api,
      key: Buffer.alloc(32),
    };
    const refusal = await login.completeLogin(callback).then(
      () => null,
      (error: unknown) => error,
    );
    // The Control Plane refuses the code: not the page's own refusal, so the callback answers 502.
    assert.ok(refusal instanceof IntrospectionAPIError, String(refusal));
    assert.ok(!(refusal instanceof login.LoginRefused));
    assert.equal(refusal.status, 400);
    console.log(
      "ok  sign-in: the code exchange is the SDK's, and an unissued code is refused by the platform",
    );
    console.log("\n1 login check passed");
  } finally {
    await polly.stop();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
