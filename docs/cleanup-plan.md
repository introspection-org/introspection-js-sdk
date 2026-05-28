# Repo cleanup & coverage plan

> Status: **draft, awaiting review**. Author: cleanup pass following the multi-week subagent / baggage / proxy / dependabot work.
>
> Scope: examples, tests, recordings, coverage tooling. **Not** SDK source changes — those belong in feature PRs.
>
> Goal: take a repo that grew organically across several developers into a shape a new contributor can navigate in 10 minutes, with a measurable test-coverage floor.

---

## TL;DR

We ship **8 framework integrations** with roughly **30 example files**, **27 test files**, **6,500 LOC of test code**, and **zero code-coverage measurement**. The structure has obvious intern-era inconsistencies (two `anthropic*` folders for two unrelated SDKs, pi has 4 test files while OpenInference has 0, folder/file naming differs across frameworks, dual-export coverage is a sparse 11-out-of-32 matrix).

This plan proposes:

1. Install code coverage (now), get a baseline.
2. Rename two folders + standardise example naming convention.
3. Consolidate per-framework test files (~12 fewer files, same coverage).
4. Fill the coverage gaps the baseline surfaces.
5. Refactor dual-export examples around a shared helper.

Each phase is independently shippable.

---

## Current state — inventory

### Frameworks & their npm packages

| Framework area             | npm package(s)                                       | Example folder                    | Test file(s)                                                                                                                     |
| -------------------------- | ---------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Agents SDK          | `@openai/agents`                                     | `examples/otel/openai/`           | `test-openai-subagents.test.ts`                                                                                                  |
| Anthropic raw SDK          | `@anthropic-ai/sdk`                                  | `examples/otel/anthropic-sdk/` 🚩 | `test-anthropic-sdk-subagents.test.ts`, `test-anthropic-thinking.test.ts`                                                        |
| Anthropic Claude Agent SDK | `@anthropic-ai/claude-agent-sdk`                     | `examples/otel/anthropic/` 🚩     | `test-claude.test.ts`, `test-claude-wrapper.test.ts`, `test-claude-baggage-proxy.test.ts`                                        |
| Gemini                     | `@google/genai`                                      | `examples/otel/gemini-sdk/`       | `test-gemini-thinking.test.ts`                                                                                                   |
| LangChain                  | `@langchain/*` + `IntrospectionCallbackHandler`      | `examples/otel/langchain/`        | `test-langchain.test.ts`, `test-langchain-handler.test.ts`, `test-langchain-subagents.test.ts`, `test-langchain-baggage.test.ts` |
| Vercel AI SDK              | `ai` + `@ai-sdk/*`                                   | `examples/otel/vercel/`           | `test-vercel.test.ts`, `test-vercel-subagents.test.ts`, `test-vercel-baggage-openai.test.ts`                                     |
| Mastra                     | `@mastra/*` + `IntrospectionMastraExporter`          | `examples/otel/mastra/`           | `test-mastra.test.ts`, `test-mastra-exporter.test.ts`, `test-mastra-subagents.test.ts`                                           |
| Pi                         | `@mariozechner/pi-*` + `IntrospectionPiInstrumentor` | `examples/otel/pi/`               | `test-pi-attributes.test.ts`, `test-pi-baggage.test.ts`, `test-pi-instrumentation.test.ts`, `test-pi-subagents.test.ts`          |
| OpenInference              | `@arizeai/openinference-*`                           | `examples/otel/openinference/`    | **none** ❌                                                                                                                      |
| OpenClaw                   | `@introspection-sdk/introspection-openclaw`          | `examples/otel/openclaw/`         | `test-openclaw-attributes.test.ts`                                                                                               |
| Raw OTel (no wrapper)      | —                                                    | `examples/otel/raw/` 🚩           | **none** ❌                                                                                                                      |

🚩 = naming or structure problem listed below.
❌ = no test coverage.

### Coverage matrix — dual-export examples

|                                 | arize                          | braintrust | langfuse | langsmith |
| ------------------------------- | ------------------------------ | ---------- | -------- | --------- |
| OpenAI Agents                   | ✅                             | ✅         | ✅       | ✅        |
| Claude Agent SDK                | ❌                             | ✅         | ✅       | ✅        |
| Anthropic raw SDK               | ❌                             | ❌         | ❌       | ❌        |
| Gemini                          | ❌                             | ❌         | ❌       | ❌        |
| LangChain                       | (via `test-langchain.test.ts`) | ❌         | ❌       | ❌        |
| Vercel AI SDK                   | (via `test-vercel.test.ts`)    | ❌         | ❌       | ❌        |
| Mastra                          | ✅                             | ✅         | ✅       | ✅        |
| Pi                              | ❌                             | ❌         | ❌       | ❌        |
| OpenInference (openai upstream) | ✅                             | ✅         | ✅       | ❌        |

**11 of 36 cells filled.** Mastra and OpenAI Agents are complete; everything else is partial.

### Code-coverage tooling

None. No `@vitest/coverage-v8` package. No `coverage` block in `tests/vitest.config.ts`. No CI gate. **We do not know what percentage of the ~5,000 LOC of SDK source the ~6,500 LOC of test code actually exercises.**

---

## Naming conventions (decisions, agreed)

These should be applied consistently going forward; any new code that doesn't match is a review-block.

### Anthropic folder layout

Two npm packages, two top-level folders, both peers (not nested):

| Folder                     | npm package                      | What it demonstrates                                                |
| -------------------------- | -------------------------------- | ------------------------------------------------------------------- |
| `examples/otel/anthropic/` | `@anthropic-ai/sdk`              | Raw Anthropic Node SDK — `client.messages.create()` directly        |
| `examples/otel/anthropic/` | `@anthropic-ai/claude-agent-sdk` | Claude Agent SDK — high-level agent that spawns the `claude` binary |

Maps cleanly onto the published package names. Same applies to the SDK source files: `anthropic.ts` is the instrumentor for the raw SDK, `claude-hooks.ts` / `claude-wrapper.ts` are for the agent SDK.

### `raw/` → `otel/`

`examples/raw/multi-turn-conversation.ts` is the only file under `examples/otel/raw/`. The folder will be renamed to `examples/otel/` to make its intent explicit: "show what wiring Introspection looks like with hand-rolled OTel, no framework-specific wrapper."

### Example file naming pattern

```
examples/<framework>/<integration>[-<vendor>].ts
```

Where:

- `<framework>` is the folder name (one of: `openai`, `anthropic`, `claude-agent`, `gemini`, `langchain`, `vercel`, `mastra`, `pi`, `openinference`, `openclaw`, `otel`)
- `<integration>` describes the SDK entrypoint being demonstrated (`agents`, `agent`, `handler`, `subagents`, `native`, etc.) — keep the framework's own terminology where possible
- `<vendor>` is only present for dual-export examples (`arize`, `braintrust`, `langfuse`, `langsmith`)

Examples:

- `examples/otel/openai/agents.ts` — base
- `examples/otel/openai/agents-arize.ts` — dual-export
- `examples/otel/mastra/agent.ts` — base
- `examples/otel/mastra/agent-arize.ts` — dual-export

Today's drift:

- `mastra/agent-*.ts` ✅ matches
- `openai/agents-*.ts` ✅ matches
- `anthropic/claude-agent-*.ts` 🚩 — `claude-agent` is the folder; the prefix is redundant; will become `claude-agent/*-arize.ts` after the rename
- `anthropic-sdk/anthropic-native.ts` 🚩 — `anthropic` is the folder; the prefix is redundant; will become `anthropic/native.ts`
- `gemini-sdk/gemini-native.ts` 🚩 — same issue; will become `gemini/native.ts`
- `pi/pi-native.ts`, `pi/pi-subagents-baggage.ts` 🚩 — same; will become `pi/native.ts`, `pi/subagents.ts`

### Test file naming pattern

```
tests/observability/test-<framework>.test.ts
```

**One file per framework.** Multiple test surfaces become nested `describe()` blocks inside the same file, not separate files.

Today we have 27 observability test files for ~10 frameworks. Target is ~10–12 (one per framework + a small number of cross-cutting concerns like `test-baggage-propagation.test.ts`).

### Recording directory naming

Polly's persister-fs writes `<recordingName>_<hash>/recording.har`. The recording proxy writes `<recordingName>/recording.har` (no hash). Both coexist under `tests/recordings/`. This is fine but needs a short README that explains the two formats. No code rename — Polly's hash suffix isn't worth fighting.

### Dual-export example pattern

Per the decision above: **one file per (framework, vendor) pair, sharing a helper.**

Proposed shape:

```
examples/_shared/dual-export.ts          # exports vendor setup helpers
examples/otel/openai/agents-arize.ts          # imports + uses
examples/otel/openai/agents-braintrust.ts     # imports + uses
...
```

Each example file becomes ~50 LOC: business logic + a one-line vendor helper call + introspection wiring. Today the equivalents are 120–180 LOC each, mostly boilerplate.

---

## Phase 1 — Code coverage tooling

Goal: install measurement, capture a baseline, gate CI on it.

### Tasks

| ID  | Task                                                                                                                                         | Files                      | Acceptance                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------- |
| 1.1 | Add `@vitest/coverage-v8` to `tests/devDependencies`                                                                                         | `tests/package.json`       | `pnpm install` resolves it                            |
| 1.2 | Add `coverage` block to vitest config (v8 provider, html + json-summary + text reporters, include `packages/*/src/**`, exclude tests + dist) | `tests/vitest.config.ts`   | `pnpm test:cov` produces `coverage/`                  |
| 1.3 | Add `test:cov` and `test:cov:check` scripts                                                                                                  | `tests/package.json`       | scripts run end-to-end                                |
| 1.4 | Wire CI job that runs `pnpm test:cov:check` and uploads HTML as an artifact                                                                  | `.github/workflows/ci.yml` | CI green; artifact downloadable from run page         |
| 1.5 | Add coverage thresholds — START at the baseline (no regression) rather than aspirational numbers                                             | `tests/vitest.config.ts`   | red CI if any package's coverage drops below baseline |
| 1.6 | Document the workflow in `tests/README.md` (how to run locally, how to read the report, where the baseline lives)                            | `tests/README.md`          | matches the script names                              |

### Acceptance for the phase

- `pnpm test:cov` works locally; HTML report opens; per-file coverage is visible.
- CI fails on a synthetic regression PR (delete a test, watch coverage drop, watch CI go red).
- A per-package coverage summary (lines / branches / functions) lives in the PR description as a baseline table.

### Not in scope for this phase

- Raising coverage thresholds (that's phase 4).
- Refactoring tests (that's phase 3).

---

## Phase 2 — Folder & file renames

Goal: apply the naming conventions above. No behavior change; entirely structural.

### Tasks

| ID   | Task                                                                                                                      | From → To                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --- |
| 2.1  | Rename Anthropic agent folder                                                                                             | `examples/otel/anthropic/` → `examples/otel/anthropic/`                                                                            |
| 2.2  | Rename Anthropic raw SDK folder                                                                                           | `examples/otel/anthropic-sdk/` → `examples/otel/anthropic/`                                                                        |
| 2.3  | Drop redundant `claude-agent-` prefix inside `examples/otel/anthropic/`                                                   | `claude-agent.ts` → `agent.ts`, `claude-agent-subagents.ts` → `subagents.ts`, `claude-agent-braintrust.ts` → `braintrust.ts`, etc. |
| 2.4  | Drop redundant `anthropic-` prefix inside `examples/otel/anthropic/`                                                      | `anthropic-native.ts` → `native.ts`, `subagents-baggage.ts` → `subagents.ts`                                                       |
| 2.5  | Rename `examples/otel/gemini-sdk/` → `examples/otel/gemini-sdk/` and `gemini-native.ts` → `native.ts`                     | —                                                                                                                                  |
| 2.6  | Drop redundant `pi-` prefix inside `examples/otel/pi/`                                                                    | `pi-native.ts` → `native.ts`, `pi-subagents-baggage.ts` → `subagents.ts`                                                           |
| 2.7  | Rename `examples/otel/raw/` → `examples/otel/` and `multi-turn-conversation.ts` → `multi-turn.ts` (drop redundant suffix) | —                                                                                                                                  |
| 2.8  | Update every `pnpm <script>` mapping in `examples/package.json` to the new paths                                          | `examples/package.json`                                                                                                            |     |
| 2.9  | Update every reference in `README.md`, `examples/README.md`, `tests/README.md`, `AGENTS.md`                               | —                                                                                                                                  |     |
| 2.10 | Update every reference in PR descriptions / commit messages going forward (nothing to do historically)                    | —                                                                                                                                  |     |

### Acceptance for the phase

- `pnpm test:cov` still passes on the rebuilt structure (no regressions).
- Every example still runs (smoke them locally; CI doesn't run them but the package.json scripts must resolve).
- All docs cross-reference the new paths; no broken `examples/anthropic/claude-agent...` links remain.

---

## Phase 3 — Test consolidation

Goal: one test file per framework. Same coverage, fewer files, less duplicated setup.

### Tasks

| ID  | From (multiple files)                                                                                                               | To (single file)            | Notes                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------ |
| 3.1 | `test-claude.test.ts` + `test-claude-wrapper.test.ts` + `test-claude-baggage-proxy.test.ts`                                         | `test-claude-agent.test.ts` | Three nested `describe`s |
| 3.2 | `test-langchain.test.ts` + `test-langchain-handler.test.ts` + `test-langchain-subagents.test.ts` + `test-langchain-baggage.test.ts` | `test-langchain.test.ts`    | Four nested `describe`s  |
| 3.3 | `test-mastra.test.ts` + `test-mastra-exporter.test.ts` + `test-mastra-subagents.test.ts`                                            | `test-mastra.test.ts`       | Three nested `describe`s |
| 3.4 | `test-pi-attributes.test.ts` + `test-pi-baggage.test.ts` + `test-pi-instrumentation.test.ts` + `test-pi-subagents.test.ts`          | `test-pi.test.ts`           | Four nested `describe`s  |
| 3.5 | `test-vercel.test.ts` + `test-vercel-subagents.test.ts` + `test-vercel-baggage-openai.test.ts`                                      | `test-vercel.test.ts`       | Three nested `describe`s |
| 3.6 | `test-anthropic-sdk-subagents.test.ts` + `test-anthropic-thinking.test.ts`                                                          | `test-anthropic.test.ts`    | Two nested `describe`s   |

### Acceptance for the phase

- Test count drops from ~165 (≈27 files) to roughly the same count (≈12 files).
- `pnpm test:cov` still green; coverage numbers should be unchanged or marginally up (de-duplicated setup, no functional change).
- Each consolidated file has a header comment listing the nested concerns.

---

## Phase 4 — Close the coverage gaps surfaced by Phase 1

Goal: drive the metrics revealed by Phase 1 toward a reasonable floor.

### Predicted gaps (to be confirmed by Phase 1 baseline)

| Package / file                                                | Likely current coverage | Target   |
| ------------------------------------------------------------- | ----------------------- | -------- |
| `packages/introspection-node/src/converters/openinference.ts` | <20% (no tests)         | 70%      |
| `packages/introspection-node/src/gemini.ts`                   | ~50% (one test file)    | 80%      |
| `packages/introspection-node/src/mastra-exporter.ts`          | ~60%                    | 80%      |
| `packages/introspection-node/src/langchain-handler.ts`        | ~60%                    | 80%      |
| `packages/introspection-node/src/claude-hooks.ts`             | ~75%                    | 85%      |
| `packages/introspection-pi/src/*`                             | ~85% (over-tested)      | maintain |

### Tasks

| ID  | Task                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------- |
| 4.1 | Add `test-openinference.test.ts` exercising `openinference.ts` converter (no Polly needed — pure attribute transforms) |
| 4.2 | Extend `test-gemini.test.ts` with a baggage-propagation test (parallels langchain-baggage / pi-baggage shape)          |
| 4.3 | Extend `test-mastra.test.ts` with edge cases for `mastra-exporter.ts` (tool calls, multi-step, error paths)            |
| 4.4 | Extend `test-langchain.test.ts` with the LangGraph thread-id paths that aren't currently covered                       |
| 4.5 | Raise per-package coverage thresholds in `vitest.config.ts` to the targets above; CI gates on these                    |

### Acceptance for the phase

- Every SDK source file is at ≥70% line coverage.
- CI fails if a PR drops any file below its threshold.

---

## Phase 5 — Dual-export example refactor

Goal: bring the 36-cell matrix to consistent fill — and not by hand-writing 25 near-identical 150-line files.

### Shared helper

```
examples/_shared/dual-export.ts
  - export function withArize(serviceName): { instrumentations, exporters }
  - export function withBraintrust(serviceName): { instrumentations, exporters }
  - export function withLangfuse(serviceName): { instrumentations, exporters }
  - export function withLangsmith(serviceName): { instrumentations, exporters }
```

Each helper returns the per-vendor OTel wiring: instrumentation registrations, exporter setup, env-var checks.

### Per-example shape (target ~60 LOC each)

```ts
import { setupTracing } from "@introspection-sdk/introspection-node";
import { withArize } from "../_shared/dual-export";
// ... framework imports ...

const provider = setupTracing({ ...withArize("openai-agents-arize") });
// ... ~40 LOC of business logic identical to base example ...
```

### Tasks (one per missing matrix cell, plus refactor existing ones)

| ID  | Task                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | Land the shared helper + refactor the existing dual-export examples (OpenAI ×4, Claude Agent ×3, Mastra ×4) onto it         |
| 5.2 | Add Claude Agent + Arize (the only Anthropic-side gap among existing dual-exports)                                          |
| 5.3 | Add the 4 missing Anthropic-raw-SDK dual-export examples                                                                    |
| 5.4 | Add the 4 missing Gemini dual-export examples                                                                               |
| 5.5 | Add the 4 missing Pi dual-export examples                                                                                   |
| 5.6 | Add the 3 missing Vercel dual-export examples (arize is already wired via `test-vercel.test.ts`; add the other three)       |
| 5.7 | Add the 3 missing LangChain dual-export examples (langsmith is via `test-langchain.test.ts`; add arize/braintrust/langfuse) |

### Acceptance for the phase

- Matrix is 28/28 (every framework × every vendor), excluding cells that don't make sense (e.g. OpenInference-of-OpenAI ×langsmith).
- Each example is ≤80 LOC.
- A single regenerate-from-template script can be run as a sanity check that all examples follow the helper pattern.

---

## Risk + sequencing

- **Phase 1 first** (small, independent, reveals truth). No risk.
- **Phase 2 before phase 3** so consolidation lands on the renamed structure, not the old one.
- **Phase 3 before phase 4** so coverage gaps surface against the new, consolidated test files.
- **Phase 5 last** — it's the biggest example churn and depends on naming conventions from phase 2.

Each phase is one PR. Phases 1–4 are small (≤500 LOC each). Phase 5 is larger but mechanical.

---

## Out of scope for this plan

- SDK source changes (instrumentor refactors, integration cleanups, new converters). Those follow product/feature branches.
- Migrating the recording proxy to a Polly Adapter subclass — already flagged as a separate follow-up.
- Documentation site / API reference generation.
- Browser-package coverage (`packages/introspection-browser`) — handled when we have a browser-specific harness.
- Versioning / release process changes.

---

## Open questions

- For Phase 1 thresholds: do we want a single repo-wide floor (e.g. 70%) or per-package floors (`introspection-node` 75%, `introspection-pi` 80%, etc.)?
- For Phase 5: should the helper live in `examples/_shared/` (proposed), or in a published `@introspection-sdk/dual-export-examples` package? The former is simpler; the latter is reusable outside this repo.
- For Phase 3 consolidation: do we want the per-framework file to live in `tests/observability/` (current) or move to `tests/<framework>/test.test.ts` for better organization once there's only one file per framework?
