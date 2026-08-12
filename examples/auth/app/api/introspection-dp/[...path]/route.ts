import { NextResponse } from "next/server";

const BODY_LOG_LIMIT = 2000;

function dpUrl(): string {
  return (
    process.env.INTROSPECTION_DP_URL ??
    process.env.NEXT_PUBLIC_INTROSPECTION_DP_URL ??
    "http://localhost:8002"
  ).replace(/\/+$/, "");
}

function forwardHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of ["content-type", "accept", "cookie"] as const) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const name of ["content-type", "cache-control", "set-cookie"] as const) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return headers;
}

async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const sourceUrl = new URL(request.url);
  const target = `${dpUrl()}/${path.map(encodeURIComponent).join("/")}${sourceUrl.search}`;
  const method = request.method.toUpperCase();
  const body =
    method === "GET" || method === "HEAD" ? undefined : await request.text();

  try {
    const upstream = await fetch(target, {
      method,
      headers: forwardHeaders(request),
      body,
      redirect: "manual",
      cache: "no-store",
    });
    if (
      (upstream.headers.get("content-type") ?? "").includes("text/event-stream")
    ) {
      return new NextResponse(upstream.body, {
        status: upstream.status,
        headers: responseHeaders(upstream),
      });
    }
    const text = await upstream.text();
    if (!upstream.ok) {
      const snippet =
        text.length > BODY_LOG_LIMIT
          ? `${text.slice(0, BODY_LOG_LIMIT)}…`
          : text;
      console.error(
        `[introspection-dp] ${upstream.status} ${target}: ${snippet}`,
      );
    }
    return new NextResponse(text, {
      status: upstream.status,
      headers: responseHeaders(upstream),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[introspection-dp] failed to reach ${target}: ${message}`);
    return NextResponse.json(
      { error: `Failed to reach Data Plane: ${message}` },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
