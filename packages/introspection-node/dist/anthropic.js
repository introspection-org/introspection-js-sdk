/**
 * Lightweight Anthropic instrumentor for Introspection SDK.
 *
 * Captures the full Anthropic response including thinking blocks (extended
 * thinking) with signatures, which third-party instrumentors drop.
 *
 * Supports both non-streaming (`messages.create`) and streaming
 * (`messages.create({ stream: true })`) calls.
 *
 * @example
 * ```ts
 * import { AnthropicInstrumentor } from "@introspection-sdk/introspection-node";
 *
 * const instrumentor = new AnthropicInstrumentor();
 * instrumentor.instrument({ tracerProvider: provider });
 * // All client.messages.create calls are now traced
 * ```
 */
import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------
/** Sentinel value for redacted thinking blocks — content was encrypted by safety systems. */
export const REDACTED_THINKING_CONTENT = "[redacted]";
function blockToParts(block) {
    const bt = block.type || "";
    if (bt === "text") {
        return [{ type: "text", content: block.text || "" }];
    }
    if (bt === "thinking") {
        const part = {
            type: "thinking",
            content: block.thinking || undefined,
            signature: block.signature || undefined,
            provider_name: "anthropic",
        };
        return [part];
    }
    if (bt === "redacted_thinking") {
        return [
            {
                type: "thinking",
                content: REDACTED_THINKING_CONTENT,
                signature: block.data || undefined,
                provider_name: "anthropic",
            },
        ];
    }
    if (bt === "tool_use") {
        return [
            {
                type: "tool_call",
                id: block.id || "",
                name: block.name || "",
                arguments: block.input,
            },
        ];
    }
    if (bt === "tool_result") {
        return [
            {
                type: "tool_call_response",
                id: block.tool_use_id || "",
                response: block.content != null ? String(block.content) : "",
            },
        ];
    }
    return [];
}
function convertAnthropicInput(messages) {
    const result = [];
    for (const msg of messages) {
        const role = msg.role || "user";
        const content = msg.content;
        if (typeof content === "string") {
            result.push({
                role: role,
                parts: [{ type: "text", content }],
            });
        }
        else if (Array.isArray(content)) {
            const parts = [];
            for (const block of content) {
                const rec = typeof block === "object" && block !== null
                    ? block
                    : { type: "text", text: String(block) };
                parts.push(...blockToParts(rec));
            }
            if (parts.length > 0) {
                result.push({ role: role, parts });
            }
        }
    }
    return result;
}
function convertAnthropicOutput(content) {
    const parts = [];
    let hasToolCalls = false;
    for (const block of content) {
        const newParts = blockToParts(block);
        for (const p of newParts) {
            if (p.type === "tool_call")
                hasToolCalls = true;
        }
        parts.push(...newParts);
    }
    if (parts.length === 0)
        return [];
    return [
        {
            role: "assistant",
            parts,
            finish_reason: hasToolCalls ? "tool-calls" : "stop",
        },
    ];
}
// ---------------------------------------------------------------------------
// Span helpers
// ---------------------------------------------------------------------------
function serializeMessages(msgs) {
    return JSON.stringify(msgs.map((m) => {
        const obj = { role: m.role, parts: m.parts };
        if ("finish_reason" in m && m.finish_reason) {
            obj.finish_reason = m.finish_reason;
        }
        return obj;
    }));
}
function startSpan(tracer, model) {
    const span = tracer.startSpan("chat", {
        kind: SpanKind.CLIENT,
        attributes: {
            "gen_ai.system": "anthropic",
            "gen_ai.provider.name": "anthropic",
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": model,
            "openinference.span.kind": "LLM",
        },
    });
    return { span, token: null };
}
function setRequestAttrs(span, kwargs) {
    const messages = kwargs.messages || [];
    const inputMsgs = convertAnthropicInput(messages);
    if (inputMsgs.length > 0) {
        span.setAttribute("gen_ai.input.messages", serializeMessages(inputMsgs));
    }
    const system = kwargs.system;
    if (system) {
        const sysVal = typeof system === "string"
            ? JSON.stringify([{ type: "text", content: system }])
            : JSON.stringify(system);
        span.setAttribute("gen_ai.system_instructions", sysVal);
    }
    const tools = kwargs.tools;
    if (tools && tools.length > 0) {
        const defs = tools.map((t) => ({
            name: t.name || "",
            description: t.description,
            parameters: t.input_schema,
        }));
        span.setAttribute("gen_ai.tool.definitions", JSON.stringify(defs));
    }
}
function setResponseAttrs(span, response) {
    const content = response.content;
    if (content) {
        const outputMsgs = convertAnthropicOutput(content);
        if (outputMsgs.length > 0) {
            span.setAttribute("gen_ai.output.messages", serializeMessages(outputMsgs));
        }
    }
    if (response.id)
        span.setAttribute("gen_ai.response.id", String(response.id));
    if (response.model)
        span.setAttribute("gen_ai.response.model", String(response.model));
    const usage = response.usage;
    if (usage) {
        if (usage.input_tokens != null)
            span.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens);
        if (usage.output_tokens != null)
            span.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens);
    }
    span.setStatus({ code: SpanStatusCode.OK });
}
class TracedStream {
    inner;
    span;
    blocks = [];
    currentBlock = null;
    responseId = null;
    responseModel = null;
    inputTokens = 0;
    outputTokens = 0;
    finalized = false;
    constructor(inner, span) {
        this.inner = inner;
        this.span = span;
    }
    async *[Symbol.asyncIterator]() {
        try {
            for await (const event of this.inner) {
                this.processEvent(event);
                yield event;
            }
        }
        finally {
            this.finalize();
        }
    }
    processEvent(event) {
        if (event.type === "message_start" && event.message) {
            this.responseId = event.message.id || null;
            this.responseModel = event.message.model || null;
            const usage = event.message.usage;
            if (usage)
                this.inputTokens = usage.input_tokens || 0;
        }
        else if (event.type === "content_block_start" && event.content_block) {
            const bt = event.content_block.type || "";
            this.currentBlock = { type: bt };
            if (bt === "thinking") {
                this.currentBlock.thinking = "";
                this.currentBlock.signature = "";
            }
            else if (bt === "text") {
                this.currentBlock.text = "";
            }
        }
        else if (event.type === "content_block_delta" && event.delta) {
            if (!this.currentBlock)
                return;
            const dt = event.delta.type || "";
            if (dt === "thinking_delta") {
                this.currentBlock.thinking =
                    (this.currentBlock.thinking || "") +
                        (event.delta.thinking || "");
            }
            else if (dt === "text_delta") {
                this.currentBlock.text =
                    (this.currentBlock.text || "") +
                        (event.delta.text || "");
            }
            else if (dt === "signature_delta") {
                this.currentBlock.signature =
                    (this.currentBlock.signature || "") +
                        (event.delta.signature || "");
            }
        }
        else if (event.type === "content_block_stop") {
            if (this.currentBlock) {
                this.blocks.push(this.currentBlock);
                this.currentBlock = null;
            }
        }
        else if (event.type === "message_delta") {
            const usage = event.usage;
            if (usage)
                this.outputTokens = usage.output_tokens || 0;
        }
    }
    finalize() {
        if (this.finalized)
            return;
        this.finalized = true;
        if (this.blocks.length > 0) {
            const outputMsgs = convertAnthropicOutput(this.blocks);
            if (outputMsgs.length > 0) {
                this.span.setAttribute("gen_ai.output.messages", serializeMessages(outputMsgs));
            }
        }
        if (this.responseId)
            this.span.setAttribute("gen_ai.response.id", this.responseId);
        if (this.responseModel)
            this.span.setAttribute("gen_ai.response.model", this.responseModel);
        if (this.inputTokens)
            this.span.setAttribute("gen_ai.usage.input_tokens", this.inputTokens);
        if (this.outputTokens)
            this.span.setAttribute("gen_ai.usage.output_tokens", this.outputTokens);
        this.span.setStatus({ code: SpanStatusCode.OK });
        this.span.end();
    }
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Traced wrapper around `client.messages.create(kwargs)`.
 * Creates a gen_ai span with full Anthropic response including thinking blocks.
 */
export async function tracedMessagesCreate(tracer, client, kwargs) {
    const { span } = startSpan(tracer, kwargs.model || "unknown");
    try {
        setRequestAttrs(span, kwargs);
        const response = (await client.messages.create(kwargs));
        setResponseAttrs(span, response);
        return response;
    }
    catch (e) {
        span.setStatus({
            code: SpanStatusCode.ERROR,
            message: String(e),
        });
        throw e;
    }
    finally {
        span.end();
    }
}
/**
 * Auto-instrumentor that patches `Anthropic.messages.create` to add tracing.
 *
 * Captures all content blocks including thinking (extended thinking) with
 * signatures. Supports both non-streaming and streaming calls.
 */
/**
 * Auto-instrumentor that wraps an Anthropic client instance to add tracing.
 *
 * Captures all content blocks including thinking (extended thinking) with
 * signatures. Supports both non-streaming and streaming calls.
 */
export class AnthropicInstrumentor {
    tracer = null;
     
    patchedClients = [];
    instrument(opts) {
        const { client } = opts;
        if (!client?.messages?.create) {
            throw new Error("Invalid client — pass an Anthropic client instance (new Anthropic())");
        }
        const provider = opts.tracerProvider ?? trace.getTracerProvider();
        this.tracer = provider.getTracer("introspection-anthropic");
        const origCreate = client.messages.create.bind(client.messages);
        this.patchedClients.push({ client, originalCreate: origCreate });
        const tracer = this.tracer;
         
        client.messages.create = function (...args) {
            const kwargs = args[0];
            const isStream = kwargs?.stream === true;
            const { span } = startSpan(tracer, kwargs?.model || "unknown");
            setRequestAttrs(span, kwargs || {});
            if (isStream) {
                const streamPromise = origCreate(...args);
                return streamPromise.then((stream) => new TracedStream(stream, span), (err) => {
                    span.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: String(err),
                    });
                    span.end();
                    throw err;
                });
            }
            const resultPromise = origCreate(...args);
            return resultPromise.then((response) => {
                setResponseAttrs(span, response);
                span.end();
                return response;
            }, (err) => {
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: String(err),
                });
                span.end();
                throw err;
            });
        };
    }
    uninstrument() {
        for (const { client, originalCreate } of this.patchedClients) {
            client.messages.create = originalCreate;
        }
        this.patchedClients = [];
        this.tracer = null;
    }
}
