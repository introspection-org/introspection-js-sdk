# `@introspection-sdk/coding-agent`

Opt-in OpenTelemetry capture of **Claude Code** and **Codex** sessions for the
Introspection plugin.

Both hosts use one Introspection-owned, per-session activation protocol. The
existing plugin reference loader silently writes a session-scoped request; the
next host completion hook binds it to that hook's authoritative
session/transcript and native turn boundary. Capture without the resulting
rollout-bound marker returns `not-activated` and never defaults to byte zero.
Claude Code requires 2.1.136 or newer; Codex requires CLI/Desktop 0.146.0 or
newer, and plugins are not available in the Codex IDE extension.

It turns a host's own session transcript into GenAI spans under
`service.name = "introspection-plugin"`, authenticated with the Introspection
CLI's existing login — so plugin activity correlates with the org, project, and
member captured during onboarding, without anyone pasting a second API key.

## Why a transcript reader rather than a tracing SDK

The obvious approach — wrap the agent and trace it in-process — does not apply
here. Claude Code and Codex invoke a hook as a **fresh subprocess per event**, so
there is no long-lived process to hold a tracer, and no in-memory state to
correlate a tool call with its result.

Both hosts do write an append-only JSONL transcript, and both hand the hook its
path. So capture reads the transcript instead: on each turn it consumes the bytes
appended since the last checkpoint, converts them to spans, exports, and advances
the checkpoint.

Parsing is delegated to [`@letta-ai/trajectory`][trajectory], which normalizes
Claude Code and Codex transcripts (among others) into one record contract. That
choice matters beyond not writing two parsers: it is the same normalization the
eval harness reaches through Harbor's ATIF export, so a production onboarding
session and an eval trajectory describe the same run the same way.

## Consent

Capture is **off unless a recorded opt-in enables it**. A missing, unreadable, or
malformed config resolves to disabled, as does a config written by a schema
version this build does not recognize.

Consent is recorded at `~/.introspection/telemetry.json`:

```json
{
  "version": 1,
  "enabled": true,
  "content": "on",
  "targets": ["claude-code", "codex"],
  "granted_at": "2026-08-04T10:00:00.000Z"
}
```

`content` is the privacy dial, separate from the on/off decision. The three
names are identical in the config and the `--telemetry` flag:

| Level  | What leaves the machine                                                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`  | Nothing. Records an explicit decline distinctly from "never asked".                                                                                   |
| `on`   | Span structure, timings, models, tool **names**, turn counts. No prompts, completions, tool arguments, tool output, working directory, or Git branch. |
| `full` | The above plus message content, tool payloads, working directory, and Git branch. Needed to judge a trajectory the way the eval harness does.         |

The gate is applied at span construction, and at `on` the normalizer is
additionally told to drop tool results outright — so unconsented payloads never
enter the process, rather than being filtered on the way out.

### Override

`INTROSPECTION_PLUGIN_TELEMETRY` can narrow the stored choice for one session:

```bash
INTROSPECTION_PLUGIN_TELEMETRY=off    # disable without editing the file
INTROSPECTION_PLUGIN_TELEMETRY=on     # omit content from a stored full grant
```

An enabled stored grant is always required. The override can disable capture or
narrow `full` to `on`; it cannot enable capture or widen `on` to `full`. An
unrecognized value is ignored rather than read as "on", so a typo cannot
silently enable capture. `metadata` is still accepted as `on`'s former name.

## Authentication

The CLI's device-authorization login writes `~/.introspection/credentials.json`
(mode `0600`). This package reads the project-scoped `access_token` from it and
presents it as the OTLP bearer.

It is strictly read-only: it never refreshes, never writes, and never logs a
token. Refresh belongs to the CLI, which owns the rotating refresh token. An
expired token means capture declines the run _without advancing the checkpoint_,
so the turn simply lands after the next CLI invocation refreshes it.

Tenancy is **not** sent as span attributes. The processor stamps `org_id`,
`project_id`, and `member_id` onto every record from the bearer's own claims;
attributes claiming a tenant would be both redundant and untrusted.

## Span shape

```
invoke_agent <host>              one turn — the root
├── chat <model>                 one per assistant message
└── execute_tool <name>          one per tool call, closed by its result
```

Every span carries the record's **own** timestamp, not the moment of capture.
Capture runs at the end of a turn, so wall-clock-at-export would collapse a
multi-minute turn into milliseconds and make every duration a lie.

Correlation attributes, on the resource:

| Attribute                              | Example                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| `service.name`                         | `introspection-plugin` (fixed — the platform's discriminator) |
| `introspection.plugin.host`            | `claude-code`, `codex`                                        |
| `introspection.plugin.host_version`    | `2.1.221`                                                     |
| `introspection.plugin.host_entrypoint` | `cli`, `remote`                                               |

The host version is read back out of the raw transcript, because the normalized
record contract is deliberately host-neutral and drops it. Reading it from the
transcript also beats shelling out to `claude --version`: it is the version that
produced _these_ records, and it costs no subprocess on a latency-sensitive path.

## Failure behavior

A hook runs inside an interactive coding session, so every failure mode is
fail-open. Unparseable input, an unknown event, a missing transcript, an expired
token, a dead collector, and an outright crash all resolve to "do nothing, exit
0". The binary always exits 0 — a non-zero exit is a signal to the host, and
"telemetry had a bad day" is not something a coding session should be told.

Two properties bound the damage:

- **The checkpoint advances only after a confirmed flush.** A crash or failed
  export costs a re-sent turn, never a lost one.
- **A 5s deadline caps a run.** Past it the work is abandoned and lands on the
  next turn, so capture is never the reason a turn feels slow.

## Usage

As a host hook:

```bash
introspection-capture --host claude-code            # reads the hook event on stdin
introspection-capture --host codex --dry-run --debug
```

`--dry-run` reports what _would_ be captured without exporting — worth having,
because a silent no-op is otherwise the most confusing thing about a telemetry
integration.

Programmatically:

```ts
import { capture } from "@introspection-sdk/coding-agent";

const result = await capture({
  host: "claude-code",
  sessionId: "…",
  transcriptPath: "~/.claude/projects/…/session.jsonl",
});
// result.outcome: "exported" | "no-consent" | "host-not-covered"
//               | "not-logged-in" | "no-new-records" | …
```

Outcomes are enumerated rather than free-text so a caller can explain a no-op.

## Tests

```bash
pnpm --filter introspection-tests test -- observability/test-coding-agent-capture.test.ts
```

[trajectory]: https://github.com/letta-ai/trajectory
