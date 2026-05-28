# Recording proxy

Local HTTP proxy that records and replays LLM API traffic for SDKs that bypass Polly's in-process adapters — primarily the **Claude Agent SDK**, whose `claude` binary makes Anthropic API calls from a subprocess so there's no in-process `fetch` / node-http call for Polly to intercept.

For SDKs that make their calls from the test process (LangChain, Vercel AI SDK, Mastra, Pi, OpenAI Agents SDK, the raw Anthropic Node SDK), keep using Polly — see `tests/README.md`.

## Usage

```ts
import { startProxy } from "../proxy";

const proxy = await startProxy({
  name: "claude-baggage",
  upstream: "https://api.anthropic.com",
});

const prevBaseUrl = process.env.ANTHROPIC_BASE_URL;
process.env.ANTHROPIC_BASE_URL = proxy.url;
try {
  // ... drive the real SDK ...
} finally {
  process.env.ANTHROPIC_BASE_URL = prevBaseUrl;
  await proxy.stop();
}
```

Mode is read from the same `POLLY_MODE` env var the rest of the suite uses:

```bash
# One-time record on your machine, with your own ANTHROPIC_API_KEY:
POLLY_MODE=record ANTHROPIC_API_KEY=sk-ant-... pnpm test -- recording-proxy/

# Default — replay from disk, hermetic, no key needed:
pnpm test -- recording-proxy/
```

Recordings live in `tests/recordings/<name>/<request-hash>.json`, sharing the same parent directory as the Polly HARs (Polly writes `recording.har`, the proxy writes per-request `<hash>.json` files; different extensions, no collision). Commit them alongside the test.

## How it works

1. `startProxy()` starts an HTTP listener on a random local port and returns the URL.
2. The test points the SDK at that URL via `ANTHROPIC_BASE_URL` (or whichever base-URL env var the framework respects).
3. In **record** mode the proxy forwards each request to the upstream, streams the response back to the client unchanged, and persists request + response to disk.
4. In **replay** mode the proxy looks up the recording by hash of `${method} ${url} ${scrubbed-body}` and serves it locally — no network call.

The proxy handles the `HEAD /` preflight that the Anthropic SDK issues before its first POST.

## Security

The scrub layer (`scrub.ts`) blocks known sensitive headers from being written to disk:

- `authorization`, `x-api-key`, `cookie`, `set-cookie`
- `x-claude-code-session-id`, `x-claude-remote-session-id`, `x-claude-remote-container-id`
- `openai-organization`, `x-stainless-helper-method`

A second pass scans the surviving header values for known credential patterns (Anthropic, OpenAI, AnyLLM-style keys). **If any match, `startProxy` throws rather than persisting** — fail-loud over silent leak.

Bodies are scrubbed only for UUID-shaped values so per-run randomness doesn't break the request-hash lookup; everything else is preserved verbatim, since the body is the test fixture. Audit each newly recorded fixture before committing.

## License note

We record outbound HTTPS traffic between local SDKs and the provider's public API endpoints, using credentials supplied by the developer running the recording. This is the same testing pattern as `vcr` / `nock` / `mitmproxy`. No SDK code is modified or redistributed; the proxy sits on the network path only.

## When to use mocks instead

Almost never. See the policy in `tests/README.md`. The cases where the proxy isn't useful either:

- OTel-only unit tests with no LLM call at all (just `tracer.startSpan()` + baggage assertions).
- Provider side-channel events that aren't surfaced as HTTP (rare; mock the event shape only, never the integration class).
