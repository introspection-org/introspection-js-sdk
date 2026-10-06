/**
 * Native email-code sign-in for a `native` Application's end user, then a task
 * on the Data Plane as that user.
 *
 * Run with:
 *   INTROSPECTION_NATIVE_CLIENT_ID=intro_app_xxx
 *   INTROSPECTION_PROJECT=<project slug or id>
 *   INTROSPECTION_RUNTIME_ID=<runtime id the task runs on>
 *   pnpm api-native-email-code you@example.com [--sign-out]
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 *   INTROSPECTION_SESSION_FILE  - where the session is kept between runs
 *                                 (default .introspection-session.json)
 *
 * Create the Application with `introspection applications create --type native`.
 * The session token is a Data Plane credential for a `customer` member: it
 * cannot call Control Plane routes, so the runtime is passed by id.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import {
  AuthClient,
  type SessionStorage,
} from "@introspection-sdk/introspection-node";

/** Keeps the session in one JSON file, so a second run skips sign-in. */
function fileStorage(path: string): SessionStorage {
  return {
    getItem: () => (existsSync(path) ? readFileSync(path, "utf8") : null),
    setItem: (_key, value) => writeFileSync(path, value, { mode: 0o600 }),
    removeItem: () => rmSync(path, { force: true }),
  };
}

async function main() {
  const email = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const clientId = process.env.INTROSPECTION_NATIVE_CLIENT_ID;
  const project = process.env.INTROSPECTION_PROJECT;
  const runtimeId = process.env.INTROSPECTION_RUNTIME_ID;
  if (!clientId || !project || !runtimeId) {
    throw new Error(
      "Set INTROSPECTION_NATIVE_CLIENT_ID, INTROSPECTION_PROJECT and INTROSPECTION_RUNTIME_ID",
    );
  }

  const auth = new AuthClient({
    clientId,
    project,
    storage: fileStorage(
      process.env.INTROSPECTION_SESSION_FILE ?? ".introspection-session.json",
    ),
  });
  auth.onAuthStateChange((event, session) =>
    console.log(`[auth] ${event} member=${session?.member_id ?? "-"}`),
  );

  if (!(await auth.getSession())) {
    if (!email) throw new Error("Pass the email to sign in with");
    await auth.signInWithOtp({ email });
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    // 6 digits for a returning user; a new user's first code also has letters.
    const code = await prompt.question(`Code sent to ${email}: `);
    prompt.close();
    await auth.verifyOtp({ email, token: code });
  }

  // Refreshed before expiry and after a 401 for every request it makes.
  const dp = await auth.dataPlane();
  const run = await dp.tasks.start({
    prompt: "Say hello in one sentence.",
    runtime_id: runtimeId,
  });
  console.log(await run.text());

  if (process.argv.includes("--sign-out")) await auth.signOut();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
