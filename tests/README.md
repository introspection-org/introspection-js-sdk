# Tests Package

Integration tests for the introspection SDK, ported from the stream-client project.

## Setup

```bash
# Copy and fill in env vars
cp .env.example .env

# Install dependencies
pnpm install

# Run all tests
pnpm test
```

## Structure

### Test Utilities

- **testing.ts** - `IncrementalIdGenerator`, `TestSpanExporter`, and snapshot helpers

## Environment Variables

See `.env.example` for all required variables. At minimum you need:

```
OPENAI_API_KEY=sk-...
INTROSPECTION_TOKEN=your-token
```

Additional variables are needed for specific observability platform tests.

## Running Specific Tests

```bash
# Run only processor tests
pnpm test:processors

# Run only observability tests
pnpm test:observability

# Run in watch mode
pnpm test:watch
```

## Code coverage

Coverage is enforced — both locally (`.husky/pre-commit`) and in CI (`.github/workflows/ci.yml`). Thresholds in `vitest.config.ts` are set at the current baseline as a "do not regress" floor; raising them is tracked in `docs/cleanup-plan.md` Phase 4.

```bash
# Run the full suite WITH coverage. This is what pre-commit and CI run.
pnpm test:cov

# Same as test:cov but with structured reporters for downstream gating.
pnpm test:cov:check

# Inspect the HTML report after a run.
open coverage/index.html        # macOS
xdg-open coverage/index.html    # Linux
```

The report lives at `tests/coverage/`. The `coverage/index.html` page lets you click into any file and see exact uncovered lines.

### Workflow when you add code

1. Write the SDK change.
2. Write or extend a test that exercises it.
3. Run `pnpm test:cov` locally. If coverage drops below the threshold the commit will fail; either add more test coverage or justify the gap in the PR description (and raise the threshold deliberately).
4. CI runs the same check and uploads the HTML report as a downloadable artifact.

### Current coverage

Repo-wide aggregate across the `include` packages (the gate is a repo-wide
"do-not-regress" floor, not a per-file guarantee — see the `coverage` block in
`vitest.config.ts`). `introspection-browser` is deferred pending a browser
harness.

| Metric     | Phase 1 baseline | Current | Threshold (do-not-regress) |
| ---------- | ---------------: | ------: | -------------------------: |
| Statements |              63% |     84% |                        80% |
| Branches   |              49% |     69% |                        63% |
| Functions  |              65% |     88% |                        84% |
| Lines      |              64% |     85% |                        82% |

Per-package / per-file detail is in the HTML report.

## Test policy: Polly recordings over mocks

**Always drive the real framework against a recorded LLM HTTP response. Do not mock the framework itself.**

The goal is to exercise the actual instrumentation path users hit in production — real callback ordering, real event shapes, real metadata flow. Mocking a fake AI SDK telemetry payload or a hand-crafted framework span event drifts away from the contract we ship and lets regressions slip through unnoticed.

### What this means in practice

For a new framework integration test:

1. Pick a small, realistic input prompt.
2. Call the real entry point (`ChatAnthropic.invoke`, `generateText`, `agent.generate`, `agent.prompt`, `client.messages.create`, …).
3. Run once in record mode to capture the HAR:

   ```bash
   POLLY_MODE=record pnpm test -- <test-file>
   ```

4. Commit the resulting `recordings/<name>_<hash>/recording.har`.
5. The default `pnpm test` runs in replay mode and is fast, hermetic, and offline.

### When mocks are acceptable

Only when Polly genuinely cannot record what the test needs. Specifically:

- **Subprocess / stdio SDKs.** An SDK that spawns a binary and communicates over stdio makes no HTTP call from this process, so there is nothing for Polly to intercept. Mock the stdio message stream in that case.
- **Side-channel events from the provider SDK.** Some providers manage state (e.g. OpenAI Responses-API conversation state) via internal events that aren't HTTP-visible at the call site we're testing. Mock the event shape only — never mock the integration class itself.
- **OTel-only unit tests.** A test that just verifies "baggage on the active context lands on a `tracer.startSpan()` attribute via `IntrospectionSpanProcessor`" makes no LLM call. No HTTP, no Polly needed.

If you reach for a mock, leave a one-line comment in the test header explaining why Polly couldn't be used. If the reason boils down to "it was easier to mock", the answer is to use Polly.
