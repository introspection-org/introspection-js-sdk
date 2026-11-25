import { NextResponse } from "next/server";

import { KEY_HOW_TO } from "@/lib/platform-runner";
import {
  LOGIN_COOKIE,
  keyProject,
  loginRequest,
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
  const login = loginRequest(clientId, project, `${origin}/callback`);
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
