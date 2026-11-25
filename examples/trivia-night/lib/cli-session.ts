/**
 * The local scripts' sign-in: the member `introspection login` signed in,
 * read from its credentials file, so a script acts as the same member the page
 * would. Local only; never on a deployed page.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { memberClient, type Env } from "./platform-runner";

interface Credentials {
  access_token?: string;
  dp_url?: string | null;
  project_id?: string;
  member_id?: string;
  expires_at?: number;
}

/** A client as the CLI's signed-in member, their project and member id. */
export function cliSession(env: Env = process.env) {
  const file =
    env.INTROSPECTION_CREDENTIALS?.trim() ||
    path.join(homedir(), ".introspection", "credentials.json");
  const credentials = JSON.parse(readFileSync(file, "utf8")) as Credentials;
  if (!credentials.access_token || !credentials.project_id)
    throw new Error(
      `${file} holds no signed-in project: run introspection login`,
    );
  return {
    client: memberClient(
      {
        access_token: credentials.access_token,
        dp_url: credentials.dp_url ?? null,
      },
      env,
    ),
    project: credentials.project_id,
    member: credentials.member_id ?? "",
    token: credentials.access_token,
  };
}
