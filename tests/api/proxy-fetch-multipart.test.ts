import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createProxyFetch } from "../../packages/introspection-proxy/src/index";

const PROXY_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "INTROSPECTION_EGRESS_URL",
  "INTROSPECTION_ENDPOINT_HOSTS",
] as const;
const ORIGINAL_ENV = Object.fromEntries(
  PROXY_ENV.map((key) => [key, process.env[key]]),
);

interface Received {
  contentType: string | undefined;
  body: string;
}

let server: Server | undefined;

afterEach(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (server) {
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
  }
});

/** Stands in for the forward proxy and records what reached it. */
async function listen(received: Received[]): Promise<number> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, resolve));
  return (server.address() as AddressInfo).port;
}

describe("createProxyFetch with a global FormData body", () => {
  it("sends it as multipart/form-data with its boundary", async () => {
    for (const key of PROXY_ENV) delete process.env[key];
    const received: Received[] = [];
    const port = await listen(received);
    process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;

    const form = new FormData();
    form.append(
      "file",
      new Blob(["hello upload"], { type: "text/plain" }),
      "hello.txt",
    );

    const proxyFetch = createProxyFetch({ tracing: false });
    const response = await proxyFetch("http://dp.example.test/v1/files", {
      method: "POST",
      body: form,
    });
    expect(response.status).toBe(200);

    expect(received).toHaveLength(1);
    const boundary = received[0].contentType?.match(
      /^multipart\/form-data; boundary=(.+)$/,
    )?.[1];
    expect(boundary).toBeTruthy();
    expect(received[0].body).toContain(`--${boundary}`);
    expect(received[0].body).toContain('filename="hello.txt"');
    expect(received[0].body).toContain("hello upload");
  });
});
