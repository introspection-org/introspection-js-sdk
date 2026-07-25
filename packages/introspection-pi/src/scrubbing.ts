/**
 * Content scrubbing for gen_ai spans: strip the attributes that carry
 * conversation content while keeping the structural signal (operation,
 * provider, model, usage, timing, tool names).
 *
 * For hosts that export one span stream to two backends with different data
 * policies — e.g. whole spans to a conversation store, scrubbed spans to
 * infrastructure observability — wrap the second backend's exporter:
 *
 * ```ts
 * new BatchSpanProcessor(
 *   new GenAiContentScrubbingExporter(new OTLPTraceExporter()),
 * )
 * ```
 *
 * Scrubbing is decided per attribute, on every span, regardless of
 * instrumentation scope: content-bearing keys only exist on gen_ai spans,
 * so a scope filter adds no precision — only a way to fail open. Spans with
 * no content attributes pass through untouched (same object).
 *
 * This lives beside the span producers on purpose: the list of
 * content-bearing attributes must change in the same commit as the span
 * shape that emits them.
 */
import type { Attributes } from "@opentelemetry/api";

/**
 * gen_ai attribute prefixes that carry conversation content, not structure:
 * the plaintext message, system-instruction, and tool-definition/call
 * sub-trees, plus the entire encrypted mirror (`gen_ai_encrypted.*`), which
 * duplicates the content. Everything else under gen_ai (operation, provider,
 * request/response model, usage, cost, agent, conversation, tool.name/type)
 * is structural and is kept.
 */
const GENAI_CONTENT_PREFIXES = [
  "gen_ai.input.",
  "gen_ai.output.",
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",
  "gen_ai.tool.call.arguments",
  "gen_ai.tool.call.result",
  "gen_ai_encrypted.",
] as const;

/** True for a gen_ai attribute key that carries conversation content. */
export function isGenAiContentAttribute(key: string): boolean {
  return GENAI_CONTENT_PREFIXES.some((p) => key === p || key.startsWith(p));
}

/**
 * The structural slice of an SDK `ReadableSpan` scrubbing needs. Typed
 * structurally so this package needs no dependency on
 * `@opentelemetry/sdk-trace-base`; the real span types are assignable.
 */
export interface ScrubbableSpan {
  attributes: Attributes;
}

/**
 * The structural shape of an SDK `SpanExporter`, generic over the span type
 * so wrapping a concrete exporter preserves it.
 */
export interface SpanExporterLike<S extends ScrubbableSpan = ScrubbableSpan> {
  export(
    spans: S[],
    resultCallback: (result: { code: number; error?: Error }) => void,
  ): void;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

/**
 * Return the span with content attributes removed, or the span itself when
 * it has none. The copy is a per-span attribute view behind a Proxy — the
 * original span object is never mutated, so a second processor exporting
 * the same span still sees it whole.
 */
export function scrubGenAiContent<S extends ScrubbableSpan>(span: S): S {
  if (!Object.keys(span.attributes).some(isGenAiContentAttribute)) {
    return span;
  }
  const kept: Attributes = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (!isGenAiContentAttribute(key)) kept[key] = value;
  }
  return new Proxy(span, {
    get: (target, prop) =>
      prop === "attributes" ? kept : Reflect.get(target, prop),
  });
}

/**
 * Exporter wrapper: every span reaches the delegate with its conversation
 * content stripped; spans without content attributes pass through untouched.
 */
export class GenAiContentScrubbingExporter<
  S extends ScrubbableSpan = ScrubbableSpan,
> implements SpanExporterLike<S> {
  constructor(private readonly delegate: SpanExporterLike<S>) {}

  export(
    spans: S[],
    resultCallback: (result: { code: number; error?: Error }) => void,
  ): void {
    this.delegate.export(
      spans.map((span) => scrubGenAiContent(span)),
      resultCallback,
    );
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }
}
