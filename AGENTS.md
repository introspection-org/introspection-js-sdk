# AGENTS.md

Guidance for **anyone contributing to this repo** — humans and coding agents alike. Read this before opening a PR.

If you're touching tests, examples, or framework integrations, the conventions in here are not optional: PRs that violate them will be sent back. The whole point of writing this down is that we've been bitten enough times that "we'll just do it right next time" stopped working.

The detailed phased plan that this document operationalizes lives in `docs/cleanup-plan.md`.

---

## 1. Local development workflow

```bash
# Clone + install (once)
pnpm install

# Build the SDKs (so workspace consumers resolve)
pnpm build

# Run tests in replay mode — hermetic, no API keys needed
pnpm --filter introspection-tests test

# Run tests WITH coverage (this is what pre-commit + CI do)
pnpm --filter introspection-tests test:cov

# Open the HTML coverage report after a coverage run
open tests/coverage/index.html
```

Tests run in vitest with `isolate: true` + `pool: "forks"`, so each test file gets its own worker process. OTel global state cannot leak between files. Within a single file, use `installTestOTelGlobals()` from `tests/polly-setup.ts` to keep the per-test state clean.

---

## 2. Pre-commit hook expectations

`.husky/pre-commit` runs:

1. `lint-staged` — prettier + eslint on staged files.
2. `pnpm check-types` — repo-wide typecheck.
3. `pnpm --filter introspection-tests test:cov` — full replay suite **with coverage gating**.

The coverage thresholds in `tests/vitest.config.ts` are the "do not regress" floor. A PR that drops coverage below those thresholds fails the hook **before the commit lands**, not in CI. This is deliberate: we want bad coverage caught at the keyboard, not in code review.

If your branch is intentionally adding code that can't be covered by unit tests right now, you have two options:

- **Add a test that exercises the new code.** Almost always the right answer.
- **Justify the gap in the PR description**, get explicit approval to lower a threshold, and update `docs/cleanup-plan.md` Phase 4 with the follow-up. Do not silently lower the threshold.

---

## 3. CI gating

`.github/workflows/ci.yml` runs the same coverage check on every PR and uploads the HTML report as a downloadable artifact. CI is the source of truth — if your local hook passes but CI fails, CI wins (your local has stale builds or stale deps).

---

## 4. Repo layout conventions

Set in `docs/cleanup-plan.md` and being applied across phases 2–5. Summary:

### Examples folder layout

```
examples/<framework>/<integration>[-<vendor>].ts
```

Where:

- `<framework>` is a flat folder name: `openai`, `anthropic`, `claude-agent`, `gemini`, `langchain`, `vercel`, `mastra`, `pi`, `openinference`, `openclaw`, `otel`.
- `<integration>` describes the entrypoint (`agents`, `agent`, `handler`, `subagents`, `native`).
- `<vendor>` is only present for dual-export examples (`arize`, `braintrust`, `langfuse`, `langsmith`).

Examples (post-rename):

- `examples/otel/openai/agents.ts` — base
- `examples/otel/openai/agents-arize.ts` — dual-export
- `examples/otel/claude-agent/agent.ts`, `examples/otel/claude-agent/subagents.ts`
- `examples/otel/anthropic/native.ts` (raw Anthropic Node SDK — see naming note below)
- `examples/otel/gemini/native.ts`
- `examples/otel/raw/multi-turn-conversation.ts` (the wrapper-free OTel example)

**Naming note — Anthropic is two SDKs, two folders:**

| Folder                        | npm package                                                              |
| ----------------------------- | ------------------------------------------------------------------------ |
| `examples/otel/anthropic/`    | `@anthropic-ai/sdk` (raw Node SDK)                                       |
| `examples/otel/claude-agent/` | `@anthropic-ai/claude-agent-sdk` (agent SDK; spawns the `claude` binary) |

Top-level peers under `otel/`. Do not nest one under the other.

### Tests folder layout

```
tests/observability/test-<framework>.test.ts
```

**One file per framework.** Multiple surfaces (handler, subagents, baggage propagation, instrumentor lifecycle, etc.) become nested `describe()` blocks inside the same file. Three or four files per framework is a smell — that was the intern-era pattern this repo is moving away from.

If a test concern genuinely spans multiple frameworks (e.g. `test-baggage-propagation.test.ts` for cross-framework baggage behaviour), it can be its own file.

### Recordings layout

```
tests/recordings/<name>/recording.har
```

Both Polly and the recording proxy write to this directory. Polly appends a `_<hash>` suffix (`langchain-baggage_1406006881/`); the proxy doesn't. Both formats are HAR 1.2 and inspectable in any HAR viewer.

---

## 5. SDK API surface conventions

### Do not add new `with*` context helpers

`IntrospectionClient` already exposes the canonical baggage-setting API:

- `withAgent(agentName, agentId, callback)` — `gen_ai.agent.name` / `gen_ai.agent.id`
- `withConversation(conversationId, previousResponseId, callback)` — `gen_ai.conversation.id` / `gen_ai.request.previous_response_id`
- `withUserId(userId, callback)` — `identity.user_id`
- `withAnonymousId(anonymousId, callback)` — `identity.anonymous_id`
- `withBaggage(values, callback)` — escape hatch for arbitrary baggage values

**Do not introduce additional `withFoo` / `withGenAi` / combined helpers.** If three of those keys are commonly set together at a call site, the answer is to nest the existing helpers, not to add sugar.

### Examples should use the explicit methods, not `withBaggage`

When an example sets a known semantic-convention key (agent name, conversation id, user id), use the named helper. Reserve `withBaggage({ "some.custom.key": "value" })` for truly ad-hoc values.

Good:

```ts
introspect.withAgent("researcher", "researcher-1", () =>
  introspect.withConversation(conversationId, undefined, () =>
    client.messages.create({ ... }),
  ),
);
```

Avoid in examples:

```ts
introspect.withBaggage(
  {
    "gen_ai.agent.name": "researcher",
    "gen_ai.agent.id": "researcher-1",
    "gen_ai.conversation.id": conversationId,
  },
  () => client.messages.create({ ... }),
);
```

### Framework integrations must honor baggage

Any new integration that stamps `gen_ai.*` attributes on spans **must** read the active OTel baggage as a fallback source for `gen_ai.conversation.id`, `gen_ai.agent.name`, `gen_ai.agent.id`. Existing references:

- `packages/introspection-node/src/anthropic.ts` — baggage read in patched `client.messages.create`
- `packages/introspection-node/src/span-processor.ts` — baggage read in `onEnd`
- `packages/introspection-node/src/claude-hooks.ts` — `_resolveIdentity` helper
- `packages/introspection-node/src/langchain-handler.ts` — `_readBaggage` helper
- `packages/introspection-node/src/converters/vercel.ts` — maps `ai.*` → `gen_ai.*` for AI SDK spans (runs inside `IntrospectionSpanProcessor.onEnd`)

This is what lets users wrap any framework call in `withAgent` / `withConversation` and get the right attributes without per-framework metadata threading.

### Framework integrations must stay under 10 LOC

The boilerplate a user copies to wire a new framework — setup + instrumentor construction + the per-call wrapping idiom — must be **fewer than 10 lines of code**, excluding business logic.

| Framework          | Integration LOC |
| ------------------ | --------------: |
| OpenAI Agents SDK  |               1 |
| Claude Agent SDK   |               2 |
| LangChain          |               3 |
| Vercel AI SDK      |               3 |
| Pi                 |               3 |
| Anthropic Node SDK |               7 |
| Mastra             |               9 |

If a new integration grows past 10 LOC, do not push the cost onto every example. Ask what the SDK should absorb instead: a missing baggage reader, a missing one-call bootstrap, a missing default that every caller is overriding the same way.

Counter-pattern: a `RunnableLambda`-wrapped LangChain example that exists only because the handler didn't read baggage. The fix wasn't a smarter wrapper, it was making the handler honor baggage. The wrapper went away.

### `setupTracing()` is required for baggage to propagate

`context.with()` is a no-op unless `AsyncLocalStorageContextManager` is installed. Any example that uses `withAgent` / `withConversation` / `withBaggage` must call `setupTracing()` first. `setupTracing()` warns by default if another context manager is already registered (silent baggage drops are the footgun this SDK exists to prevent); set `INTROSPECTION_STRICT_TRACING=1` to upgrade to throw.

Tests installing their own provider should use the `installTestOTelGlobals()` helper from `tests/polly-setup.ts` — it disables prior registrations first so the install can't silently no-op.

---

## 6. Test conventions

### Polly recordings over mocks — no exceptions for HTTP-reachable APIs

Always drive the real framework against a recorded LLM HTTP response. **Do not mock the framework itself** (no fake `RunnableLambda`s, no hand-crafted AI SDK telemetry event payloads, no fabricated Mastra span events, no mocked Claude Agent SDK async generators).

There are exactly two cases where a mock is acceptable. If your situation doesn't match one of them, use a recording.

1. **OTel-only unit tests with no LLM call at all** — e.g. a test that just calls `tracer.startSpan()` and asserts the `IntrospectionSpanProcessor` reads baggage. Nothing crosses a network boundary, so there's nothing to record.
2. **Provider-internal side-channel events that aren't surfaced as HTTP** — extremely rare. Even then, mock only the event payload shape, never the integration class.

Two recording mechanisms cover everything else:

- **Polly** — for SDKs that make HTTP calls from the test process (LangChain, Vercel AI SDK, Mastra, Pi, OpenAI Agents SDK, raw Anthropic Node SDK, OpenAI Node SDK). See `tests/README.md`.
- **Recording proxy** — for SDKs that make HTTP calls from a subprocess and bypass in-process interception (Claude Agent SDK). See `tests/recording-proxy/README.md`.

If you reach for a mock, leave a one-line comment in the test header explaining which of the two exceptions applies. If neither applies, you're using the wrong tool.

### Use the right base URL in tests

Tests should pass `baseURL` explicitly to SDK clients via the `pollyEndpoints` constants in `tests/polly-setup.ts`, not rely on `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` env vars. Host shells (Claude Code, AnyLLM dev setups) pre-set these and they break Polly URL matching across record and replay.

---

## 7. Things to avoid that we've already learned the hard way

| Trap                                                                               | What happened                                                                                                     | What to do instead                                                  |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Mocking framework SDKs to "simplify" tests                                         | Mocks drift from real SDK behaviour, mask integration bugs, and tests pass while production breaks                | Real framework + Polly or recording proxy                           |
| Adding a new `with*` helper because nesting two is "ugly"                          | API surface bloats; users have N ways to do one thing                                                             | Nest the existing helpers, accept the two extra lines               |
| `optionalDependencies` for things tests actually need                              | pnpm configs that skip optional deps silently break tests                                                         | `devDependencies` if tests need them                                |
| Per-test Polly init                                                                | Each `polly.stop()` overwrites the HAR with only that test's entries                                              | One Polly per file (`beforeAll`/`afterAll`)                         |
| Per-test OTel global registration                                                  | OTel silently refuses replacement; tests inherit stale state                                                      | `installTestOTelGlobals()` in `beforeEach`                          |
| Forking a workflow file from the public repo                                       | App-token `repositories: introspection-js-sdk` becomes wrong on a fork                                            | Verify every `owner:` / `repositories:` reference matches THIS repo |
| Hashing the request body for recording lookup                                      | SDKs auto-inject machine-specific content (default system prompts, billing nonces) — body differs across machines | Match on `method + URL + call-order` instead                        |
| Four test files per framework with overlapping setup                               | ~50 LOC of polly + beforeEach boilerplate duplicated per file                                                     | One file per framework, nested `describe`s                          |
| Two folders named `anthropic` and `anthropic-sdk` for two different Anthropic SDKs | Nobody can tell them apart without opening files                                                                  | One folder per npm package, named after the package                 |

---

## 8. Open and tracked

Active cleanup work that operationalizes everything above lives in `docs/cleanup-plan.md`. Phases:

- **Phase 1 — coverage tooling** (this branch). Baseline captured at 63% statements / 49% branches / 65% functions / 64% lines.
- **Phase 2 — folder + file renames.** Applies the layout conventions in §4.
- **Phase 3 — test consolidation.** Drops ~12 redundant test files.
- **Phase 4 — close coverage gaps.** Raises thresholds toward 70%+.
- **Phase 5 — dual-export examples refactor.** 11/36 → 28/28 coverage matrix, shared helper.

If you're starting work on something not covered above, sanity-check it against `docs/cleanup-plan.md` first — your change might be pre-empted by an upcoming phase.
