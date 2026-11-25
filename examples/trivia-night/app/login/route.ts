import { NextResponse } from "next/server";

import { KEY_HOW_TO, apiBaseUrl } from "@/lib/platform-runner";
import {
  LOGIN_COOKIE,
  keyProject,
  loginRequest,
  sessionKey,
  spaClientId,
} from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Sends the browser to the platform's hosted login for the page's `spa` application. */
export async function GET(request: Request) {
  const clientId = spaClientId();
  if (!clientId)
    return new Response(
      "TRIVIA_SPA_CLIENT_ID is not set: see the README's Sign in section.\n",
      { status: 500 },
    );
  const sealing = sessionKey();
  if ("missing" in sealing)
    return new Response(`${sealing.missing}.\n`, { status: 500 });
  let project: string;
  try {
    project = await keyProject();
  } catch (error) {
    return new Response(
      `Could not read the agent key's project: ${(error as Error).message}\n\n${KEY_HOW_TO}\n`,
      { status: 503 },
    );
  }
  const origin = new URL(request.url).origin;
  const login = loginRequest(
    clientId,
    project,
    `${origin}/callback`,
    apiBaseUrl(),
  );
  const response = NextResponse.redirect(login.url);
  response.cookies.set(LOGIN_COOKIE, login.cookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https:"),
    path: "/callback",
    maxAge: 600,
  });
  return response;
}
