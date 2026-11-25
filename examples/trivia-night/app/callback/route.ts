import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import {
  LOGIN_COOKIE,
  LoginRefused,
  SESSION_COOKIE,
  completeLogin,
  sessionKey,
  spaClientId,
} from "@/lib/session";
import { apiBaseUrl } from "@/lib/platform-runner";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Completes the hosted login and opens the page's session for the member. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const jar = await cookies();
  try {
    if (url.searchParams.get("error"))
      throw new LoginRefused(
        `the sign-in failed: ${url.searchParams.get("error")}`,
        401,
      );
    const sealing = sessionKey();
    if ("missing" in sealing) throw new Error(sealing.missing);
    const { cookie, session } = await completeLogin({
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      cookie: jar.get(LOGIN_COOKIE)?.value,
      redirectUri: `${url.origin}/callback`,
      clientId: spaClientId(),
      cpUrl: apiBaseUrl(),
      key: sealing.key,
    });
    const response = NextResponse.redirect(new URL("/", url.origin));
    response.cookies.delete({ name: LOGIN_COOKIE, path: "/callback" });
    response.cookies.set(SESSION_COOKIE, cookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      path: "/",
      expires: new Date(session.expires_at),
    });
    return response;
  } catch (error) {
    if (!(error instanceof LoginRefused))
      console.error(`sign-in failed: ${(error as Error).message}`);
    const status = error instanceof LoginRefused ? error.status : 502;
    const reason =
      error instanceof LoginRefused
        ? error.message
        : "the platform did not complete the sign-in";
    return new Response(`Not signed in: ${reason}. Open / to try again.\n`, {
      status,
    });
  }
}
