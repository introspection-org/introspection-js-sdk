/**
 * Source-native transcript turn boundaries and response identity.
 *
 * Letta deliberately projects host transcripts into a host-neutral trajectory.
 * That projection is ideal for message content, but it discards the native
 * turn identifiers needed by the GenAI conversation processor. Boundary and
 * identity extraction therefore happens on the raw JSONL envelopes first; each
 * resulting turn is then handed to Letta independently.
 */
import { createHash } from "node:crypto";

import type { CaptureHost } from "./config.js";

export interface SourceMetadata {
  cwd?: string;
  gitBranch?: string;
}

export interface TranscriptTurn {
  /** Source-native turn key (Claude user UUID or Codex turn_id). */
  key: string;
  /** Raw JSONL for this turn, ready for Letta normalization. */
  transcript: string;
  /** UTF-8 byte offsets relative to the supplied transcript fragment. */
  startByteOffset: number;
  endByteOffset: number;
  /** False only for a trailing turn whose completion was not established. */
  complete: boolean;
  metadata: SourceMetadata;
}

export interface SegmentedTranscript {
  turns: TranscriptTurn[];
  metadata: SourceMetadata;
  /** Claude file-level sidechain mode, retained across incremental chunks. */
  claudeStandaloneSidechain?: boolean;
}

interface JsonLine {
  record: Record<string, unknown>;
  raw: string;
  startByteOffset: number;
  endByteOffset: number;
}

interface MutableTurn {
  key: string;
  lines: JsonLine[];
  startByteOffset: number;
  sawCompletion: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJsonLines(transcript: string): JsonLine[] {
  const bytes = Buffer.from(transcript, "utf8");
  const lines: JsonLine[] = [];
  let start = 0;

  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    if (newline < 0) break;
    const end = newline + 1;
    const raw = bytes.subarray(start, end).toString("utf8");
    const body = raw.slice(0, -1).trimEnd();
    if (body.length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error(
          `cannot establish turn boundaries from invalid JSONL at byte ${start}`,
        );
      }
      const record = object(parsed);
      if (record) {
        lines.push({
          record,
          raw,
          startByteOffset: start,
          endByteOffset: end,
        });
      }
    }
    start = end;
  }

  return lines;
}

function metadataFromLines(lines: JsonLine[]): SourceMetadata {
  let cwd: string | undefined;
  let gitBranch: string | undefined;

  for (const { record } of lines) {
    cwd ??= string(record.cwd);
    gitBranch ??= string(record.gitBranch);

    const payload = object(record.payload);
    if (!payload) continue;
    cwd ??= string(payload.cwd);
    const git = object(payload.git);
    gitBranch ??= git ? string(git.branch) : undefined;
  }

  return {
    ...(cwd ? { cwd } : {}),
    ...(gitBranch ? { gitBranch } : {}),
  };
}

function isConversationalClaudeRecord(
  record: Record<string, unknown>,
): boolean {
  return (
    (record.type === "user" || record.type === "assistant") &&
    object(record.message) !== undefined
  );
}

function isClaudeToolResult(message: Record<string, unknown>): boolean {
  const content = message.content;
  return (
    Array.isArray(content) &&
    content.some((block) => object(block)?.type === "tool_result")
  );
}

function isClaudeHumanStart(
  record: Record<string, unknown>,
  standaloneSidechain: boolean,
): boolean {
  if (record.type !== "user" || record.isMeta === true) return false;
  if (record.isSidechain === true && !standaloneSidechain) return false;
  const message = object(record.message);
  if (!message || isClaudeToolResult(message)) return false;
  const content = message.content;
  if (typeof content === "string") return true;
  return (
    Array.isArray(content) &&
    content.some((block) => {
      const type = object(block)?.type;
      return type === "text" || type === "image";
    })
  );
}

function finishTurn(
  turn: MutableTurn,
  endByteOffset: number,
  complete: boolean,
  filterLine: (line: JsonLine) => boolean = () => true,
): TranscriptTurn {
  const lines = turn.lines.filter(filterLine);
  return {
    key: turn.key,
    transcript: lines.map((line) => line.raw).join(""),
    startByteOffset: turn.startByteOffset,
    endByteOffset,
    complete,
    metadata: metadataFromLines(lines),
  };
}

function segmentClaude(
  lines: JsonLine[],
  transcriptBytes: number,
  finalizeTrailingTurn: boolean,
  standaloneSidechain: boolean,
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: MutableTurn | undefined;

  for (const line of lines) {
    if (isClaudeHumanStart(line.record, standaloneSidechain)) {
      if (current) {
        turns.push(
          finishTurn(current, line.startByteOffset, true, ({ record }) => {
            return !(record.type === "user" && record.isMeta === true);
          }),
        );
      }
      const key = string(line.record.uuid);
      if (!key) {
        throw new Error("Claude Code human turn is missing its native uuid");
      }
      current = {
        key,
        lines: [],
        startByteOffset: line.startByteOffset,
        sawCompletion: false,
      };
    }
    current?.lines.push(line);
  }

  if (current) {
    turns.push(
      finishTurn(
        current,
        transcriptBytes,
        finalizeTrailingTurn,
        ({ record }) => !(record.type === "user" && record.isMeta === true),
      ),
    );
  }
  return turns;
}

function codexTurnId(record: Record<string, unknown>): string | undefined {
  if (record.type !== "turn_context") return undefined;
  return string(object(record.payload)?.turn_id);
}

function isCodexCompletion(
  record: Record<string, unknown>,
  turnId: string,
): boolean {
  if (record.type !== "event_msg") return false;
  const payload = object(record.payload);
  if (!payload) return false;
  const type = payload.type;
  const eventTurnId = string(payload.turn_id);
  return (
    (type === "task_complete" || type === "turn_aborted") &&
    (eventTurnId === undefined || eventTurnId === turnId)
  );
}

function segmentCodex(
  lines: JsonLine[],
  transcriptBytes: number,
  finalizeTrailingTurn: boolean,
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: MutableTurn | undefined;

  for (const line of lines) {
    const turnId = codexTurnId(line.record);
    if (turnId && turnId !== current?.key) {
      if (current) {
        // A distinct native turn boundary proves the preceding turn finished,
        // even when an older rollout omitted its explicit completion event.
        turns.push(finishTurn(current, line.startByteOffset, true));
      }
      current = {
        key: turnId,
        lines: [],
        startByteOffset: line.startByteOffset,
        sawCompletion: false,
      };
    }
    if (!current) continue;
    current.lines.push(line);
    if (isCodexCompletion(line.record, current.key)) {
      current.sawCompletion = true;
    }
  }

  if (current) {
    turns.push(
      finishTurn(
        current,
        transcriptBytes,
        current.sawCompletion || finalizeTrailingTurn,
      ),
    );
  }
  return turns;
}

export function segmentTranscript(
  host: CaptureHost,
  transcript: string,
  options: {
    finalizeTrailingTurn?: boolean;
    claudeStandaloneSidechain?: boolean;
  } = {},
): SegmentedTranscript {
  const lines = parseJsonLines(transcript);
  const transcriptBytes = Buffer.byteLength(transcript, "utf8");
  const finalizeTrailingTurn = options.finalizeTrailingTurn ?? true;
  const hasSidechain = lines.some(
    ({ record }) =>
      isConversationalClaudeRecord(record) && record.isSidechain === true,
  );
  const hasPrimary = lines.some(
    ({ record }) =>
      isConversationalClaudeRecord(record) && record.isSidechain !== true,
  );
  const claudeStandaloneSidechain = hasPrimary
    ? false
    : (options.claudeStandaloneSidechain ?? hasSidechain);
  const turns =
    host === "claude-code"
      ? segmentClaude(
          lines,
          transcriptBytes,
          finalizeTrailingTurn,
          claudeStandaloneSidechain,
        )
      : segmentCodex(lines, transcriptBytes, finalizeTrailingTurn);
  const seen = new Set<string>();
  for (const turn of turns) {
    if (seen.has(turn.key)) {
      throw new Error("native turn key repeated non-consecutively");
    }
    seen.add(turn.key);
  }
  return {
    turns,
    metadata: metadataFromLines(lines),
    ...(host === "claude-code" ? { claudeStandaloneSidechain } : {}),
  };
}

/**
 * Opaque, deterministic response identity for one source-native agent turn.
 *
 * The session namespace is required: both Claude UUIDs and Codex turn IDs can
 * recur when a conversation is copied or forked.
 */
export function responseIdForTurn(
  host: CaptureHost,
  sessionId: string,
  turnKey: string,
): string {
  const hash = createHash("sha256");
  hash.update("introspection.coding-agent.response.v1\0");
  hash.update(host);
  hash.update("\0");
  hash.update(sessionId);
  hash.update("\0");
  hash.update(turnKey);
  return `ca_v1_${hash.digest("hex")}`;
}
