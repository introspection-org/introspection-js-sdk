/**
 * The sign-in's code exchange, as the browser sends it, against a recorded Control
 * Plane, replayed from `tests/recordings/trivia-night-login_*`. A code the
 * platform issued needs an interactive hosted login, and the token it returns
 * is a JWT the recording scrubs, so this records the exchange of a code the
 * platform never issued: the request the page sends and the refusal it gets.
 * The session it keeps, and its expiry, are unit tests in `scripts/test.ts`.
 * `pnpm test:login:record` records it against a LOCAL stack only, with
 * `INTROSPECTION_API_BASE_URL` and `NEXT_PUBLIC_TRIVIA_SPA_CLIENT_ID` set (`.env.local`).
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

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
    const login = await import("../lib/browser-session");
    const items = new Map([["trivia-night:login", JSON.stringify(FLOW)]]);
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    };
    const callback = new URL("http://localhost:3500/callback");
    callback.searchParams.set("code", "a-code-the-platform-never-issued");
    callback.searchParams.set("state", FLOW.state);
    const refusal = await login
      .completeLogin(storage, callback, fetch, {
        ...login.CONFIG,
        cpUrl: bootstrap.api,
        clientId:
          getPollyMode() === "record"
            ? (process.env.NEXT_PUBLIC_TRIVIA_SPA_CLIENT_ID ?? "")
            : REPLAY_CLIENT_ID,
      })
      .then(
        () => null,
        (error: Error) => error,
      );
    // The Control Plane refuses the code, and the page keeps no session.
    assert.match(String(refusal?.message), /the sign-in failed: 400/);
    assert.equal(items.size, 0);
    console.log(
      "ok  sign-in: the browser's code exchange reaches the platform, which refuses an unissued code",
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
