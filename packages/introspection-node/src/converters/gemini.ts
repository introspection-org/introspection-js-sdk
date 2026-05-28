/**
 * Google Gemini (`@google/genai`) format conversion functions for OTel Gen AI
 * Semantic Conventions.
 *
 * Gemini 3.x / Gemini 3.5+ models emit per-part `thoughtSignature` payloads
 * that carry encrypted reasoning context which MUST be passed back on
 * subsequent turns (especially around tool calls) for the model to maintain
 * its chain of thought.
 *
 * @see https://ai.google.dev/gemini-api/docs/thought-signatures
 *
 * Whenever a Gemini part carries a `thoughtSignature`, this converter emits a
 * `thinking` gen_ai part preceding the visible content. If the part is itself a
 * thought summary (`thought: true`), the visible thought text is used as the
 * thinking content; otherwise the signed-but-redacted sentinel
 * `REDACTED_THINKING_CONTENT` (`"[redacted]"`) is used — mirroring the way the
 * Anthropic instrumentor handles `redacted_thinking` blocks.
 */

import type {
  InputMessage,
  OutputMessage,
  MessagePart,
  ReasoningPart,
  SystemInstruction,
  ToolDefinition,
} from "@introspection-sdk/types";

/** Sentinel for parts that carry a thought signature but no visible thought content. */
const REDACTED_THINKING_CONTENT = "[redacted]";

/** Provider name reported on Gemini-produced thinking parts. */
export const GEMINI_PROVIDER_NAME = "gemini";

/** A single content part as returned by the `@google/genai` SDK. */
export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: unknown;
  };
  functionResponse?: {
    id?: string;
    name?: string;
    response?: unknown;
  };
  [key: string]: unknown;
}

/** A Content envelope as used in Gemini `contents` requests and candidate outputs. */
export interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}

/** A single candidate from a `generateContent` response. */
export interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  index?: number;
}

/** A Gemini tool function declaration. */
export interface GeminiFunctionDeclaration {
  name?: string;
  description?: string;
  parameters?: unknown;
  parametersJsonSchema?: unknown;
}

/** A Gemini tool entry — `{ functionDeclarations: [...] }`. */
export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
}

/** Normalize roles from Gemini to gen_ai. Gemini uses `model` for assistant turns. */
function normalizeRole(role: string | undefined): InputMessage["role"] {
  if (role === "model") return "assistant";
  if (role === "user" || role === "system" || role === "tool") return role;
  return "user";
}

/**
 * Convert a single Gemini part into zero-or-more gen_ai message parts.
 *
 * A part carrying a `thoughtSignature` always produces a leading `thinking`
 * part so the signed reasoning payload is preserved alongside whatever visible
 * content the part contains.
 */
function partToGenAiParts(part: GeminiPart): MessagePart[] {
  const out: MessagePart[] = [];
  const signature = part.thoughtSignature || undefined;
  const isThought = part.thought === true;

  if (isThought) {
    // Visible thought summary (Gemini emits these when `includeThoughts: true`).
    const reasoning: ReasoningPart = {
      type: "thinking",
      content: part.text || REDACTED_THINKING_CONTENT,
      signature,
      provider_name: GEMINI_PROVIDER_NAME,
    };
    out.push(reasoning);
    return out;
  }

  if (signature) {
    // Signed but non-thought part — emit a redacted thinking prefix carrying the signature.
    const reasoning: ReasoningPart = {
      type: "thinking",
      content: REDACTED_THINKING_CONTENT,
      signature,
      provider_name: GEMINI_PROVIDER_NAME,
    };
    out.push(reasoning);
  }

  if (typeof part.text === "string" && part.text.length > 0) {
    out.push({ type: "text", content: part.text });
  }

  if (part.functionCall) {
    out.push({
      type: "tool_call",
      id: part.functionCall.id,
      name: part.functionCall.name || "",
      arguments: part.functionCall.args,
    });
  }

  if (part.functionResponse) {
    out.push({
      type: "tool_call_response",
      id: part.functionResponse.id,
      name: part.functionResponse.name,
      response: part.functionResponse.response,
    });
  }

  return out;
}

/**
 * Convert a `contents` array from a Gemini request to gen_ai input messages.
 *
 * Accepts a plain string (the convenience form `generateContent({ contents: "hi" })`)
 * or an array of {@link GeminiContent} objects. Roles are normalized: Gemini's
 * `model` becomes `assistant`.
 *
 * @param contents - The Gemini request's `contents` field.
 * @returns Array of {@link InputMessage} objects.
 */
export function convertGeminiContentsToInputMessages(
  contents: string | GeminiContent[] | GeminiContent | undefined,
): InputMessage[] {
  if (!contents) return [];

  if (typeof contents === "string") {
    return [{ role: "user", parts: [{ type: "text", content: contents }] }];
  }

  const list: GeminiContent[] = Array.isArray(contents) ? contents : [contents];

  const result: InputMessage[] = [];
  for (const c of list) {
    const parts = (c.parts || []).flatMap(partToGenAiParts);
    if (parts.length === 0) continue;
    result.push({ role: normalizeRole(c.role), parts });
  }
  return result;
}

/**
 * Convert Gemini response candidates to gen_ai output messages.
 *
 * @param candidates - The `candidates` array from a `generateContent` response.
 * @returns Array of {@link OutputMessage} objects (one per candidate that has content).
 */
export function convertGeminiCandidatesToOutputMessages(
  candidates: GeminiCandidate[] | undefined,
): OutputMessage[] {
  if (!candidates || candidates.length === 0) return [];

  const result: OutputMessage[] = [];
  for (const cand of candidates) {
    const role = normalizeRole(cand.content?.role || "model");
    const parts = (cand.content?.parts || []).flatMap(partToGenAiParts);
    if (parts.length === 0 && !cand.finishReason) continue;
    const msg: OutputMessage = { role, parts };
    if (cand.finishReason) msg.finish_reason = cand.finishReason;
    result.push(msg);
  }
  return result;
}

/**
 * Convert a Gemini `systemInstruction` field to gen_ai SystemInstruction[].
 *
 * Gemini accepts either a plain string or a {@link GeminiContent} object.
 */
export function convertGeminiSystemInstructionToSemconv(
  systemInstruction: string | GeminiContent | undefined,
): SystemInstruction[] | undefined {
  if (!systemInstruction) return undefined;

  if (typeof systemInstruction === "string") {
    return [{ type: "text", content: systemInstruction }];
  }

  const result = (systemInstruction.parts || []).flatMap(
    (p): SystemInstruction[] =>
      typeof p.text === "string" && p.text.length > 0
        ? [{ type: "text", content: p.text }]
        : [],
  );
  return result.length > 0 ? result : undefined;
}

/**
 * Convert Gemini `tools` (array of `{functionDeclarations}` entries) to gen_ai
 * ToolDefinition[].
 */
export function convertGeminiToolsToToolDefinitions(
  tools: GeminiTool[] | undefined,
): ToolDefinition[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  const defs: ToolDefinition[] = [];
  for (const tool of tools) {
    for (const fn of tool.functionDeclarations || []) {
      if (!fn.name) continue;
      const def: ToolDefinition = { name: fn.name };
      if (fn.description) def.description = fn.description;
      const params = fn.parametersJsonSchema ?? fn.parameters;
      if (params) def.parameters = params;
      defs.push(def);
    }
  }
  return defs.length > 0 ? defs : undefined;
}
