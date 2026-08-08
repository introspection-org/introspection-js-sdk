/**
 * The GenAI span — the object conversation item reads return.
 *
 * These are pure-unit tests of a wire contract, so no cassettes: nothing here
 * crosses a process or network boundary, and the thing under test *is* the
 * shape (AGENTS.md §6 case 1).
 *
 * Two properties carry most of the weight, because they are the two the flat
 * representation got wrong:
 *
 * - **Nothing serializes as null.** An absent value is an absent key, so every
 *   optional field on these types is `?:` rather than `| null`.
 * - **Nothing is dropped.** The attribute tree is open — every attribute type
 *   carries an index signature — so an attribute no type declared still
 *   arrives and still round-trips.
 */

import { describe, expect, it } from "vitest";
import {
  genAiConversationId,
  genAiInputMessages,
  genAiOutputMessages,
  type Conversation,
  type GenAiSpan,
  type GenAiSpanList,
} from "../../packages/introspection-types/src";

/** Every path in a payload whose value is `null`. */
function nulls(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => nulls(child, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(
      ([key, child]) =>
        child === null ? [`${path}.${key}`] : nulls(child, `${path}.${key}`),
    );
  }
  return [];
}

/** A fully-populated item as the DP serializes it. */
const FULL_SPAN: GenAiSpan = {
  trace_id: "8f0efe5966587e51364046b44b5d0029",
  span_id: "caa8ff6f77084ded",
  parent_span_id: "623224d3c1b1a99b",
  name: "chat claude-sonnet-4-6",
  kind: "INTERNAL",
  start_time: "2026-08-04T22:14:34.506000Z",
  end_time: "2026-08-04T22:14:37.482470Z",
  duration_ns: 2976470577,
  status: { code: "Unset" },
  resource: { service: { name: "coding-agent" } },
  attributes: {
    gen_ai: {
      operation: { name: "chat" },
      provider: { name: "anthropic" },
      conversation: { id: "019fcee7-4fcc-7793-a1ce-8047b3518303" },
      agent: { id: "agent:019fced4", name: "agent" },
      request: { model: "claude-sonnet-4-6" },
      response: { model: "claude-sonnet-4-6", id: "msg_011Cdi" },
      usage: {
        input_tokens: 1527,
        output_tokens: 45,
        cache_creation: { input_tokens: 1524 },
      },
      cost: { usd: 0.0098 },
      input: {
        messages: [{ role: "user", parts: [{ type: "text", content: "hey" }] }],
      },
      output: {
        messages: [
          {
            role: "assistant",
            parts: [{ type: "text", content: "hi" }],
            finish_reason: "stop",
          },
        ],
      },
    },
    introspection: {
      member: { id: "019fbe0c" },
      environment: "production",
      conversation: { position: 1, is_new: true },
    },
  },
};

/** The minimum the DP can emit: identity, timing, nothing else. */
const BARE_SPAN: GenAiSpan = {
  trace_id: "t",
  start_time: "2026-08-04T22:14:34Z",
  attributes: {},
};

describe("semconv naming", () => {
  it("addresses the tree by convention name", () => {
    // The whole point: a reader who knows the semantic conventions can find a
    // value without learning a private dialect for it.
    expect(FULL_SPAN.attributes.gen_ai?.operation?.name).toBe("chat");
    expect(FULL_SPAN.attributes.gen_ai?.provider?.name).toBe("anthropic");
    expect(FULL_SPAN.attributes.gen_ai?.request?.model).toBe(
      "claude-sonnet-4-6",
    );
    expect(FULL_SPAN.attributes.gen_ai?.response?.id).toBe("msg_011Cdi");
    expect(FULL_SPAN.attributes.gen_ai?.usage?.input_tokens).toBe(1527);
  });

  it("nests cache tokens the way the convention nests them", () => {
    // `gen_ai.usage.cache_read.input_tokens` is a nested count, not a flat
    // `cache_read_input_tokens` — this was our local extension before the
    // conventions adopted it, and the nesting is the adopted spelling.
    expect(
      FULL_SPAN.attributes.gen_ai?.usage?.cache_creation?.input_tokens,
    ).toBe(1524);
  });

  it("puts introspection attributes beside gen_ai, not inside it", () => {
    expect(FULL_SPAN.attributes.introspection?.member?.id).toBe("019fbe0c");
    expect(FULL_SPAN.attributes.introspection?.environment).toBe("production");
    // Cost is the exception: it keeps the name the span writes it with.
    // `GenAICostUsd` is materialized *from* `gen_ai.cost.usd`, so relocating
    // it into `introspection` would put a second, renamed copy of an
    // attribute already in the tree.
    expect(FULL_SPAN.attributes.gen_ai?.cost?.usd).toBe(0.0098);
    expect(FULL_SPAN.attributes.introspection?.cost_usd).toBeUndefined();
  });

  it("models summaries as dedicated conversation resources", () => {
    const summary: Conversation = {
      object: "conversation",
      id: "019fcee7",
      created_at: "2026-08-04T22:14:34.462000Z",
      updated_at: "2026-08-04T22:14:37.488000Z",
      agents: [{ id: "agent-root", name: "coordinator", depth: 0 }],
      usage: { input_tokens: 1527, output_tokens: 45, total_tokens: 1572 },
      cost: { usd: 0.0098 },
      metrics: {
        duration_ms: 3026.835672,
        trace_count: 3,
        span_count: 12,
        tool_use_count: 4,
        failed_tool_use_count: 0,
        has_errors: false,
      },
      environment: "production",
      runtime_id: "019fced4",
      runtime_group_id: "019fced3",
      recipe_git_commit_sha: "df7339af",
    };

    expect(summary.usage.output_tokens).toBe(45);
    expect(summary.metrics.span_count).toBe(12);
    expect(summary.agents?.[0]?.id).toBe("agent-root");
  });
});

describe("null is never serialized", () => {
  it("carries no nulls on a fully populated span", () => {
    expect(nulls(JSON.parse(JSON.stringify(FULL_SPAN)))).toEqual([]);
  });

  it("carries no nulls on a minimal span", () => {
    // The case that matters more: most spans are mostly empty, and the flat
    // representation rendered that emptiness as ~30 explicit nulls.
    expect(nulls(JSON.parse(JSON.stringify(BARE_SPAN)))).toEqual([]);
  });

  it("omits absent optional fields entirely rather than nulling them", () => {
    const wire = JSON.parse(JSON.stringify(BARE_SPAN));

    expect("parent_span_id" in wire).toBe(false);
    expect("end_time" in wire).toBe(false);
    expect("status" in wire).toBe(false);
  });

  it("keeps a real zero", () => {
    // Omitting nulls must not become omitting falsey values: a turn that
    // genuinely produced no output tokens is a fact, not an absence.
    const span: GenAiSpan = {
      trace_id: "t",
      start_time: "2026-08-04T22:14:34Z",
      attributes: { gen_ai: { usage: { output_tokens: 0 } } },
    };

    expect(JSON.parse(JSON.stringify(span)).attributes.gen_ai.usage).toEqual({
      output_tokens: 0,
    });
  });
});

describe("the attribute tree is open", () => {
  it("accepts and preserves an undeclared gen_ai attribute", () => {
    // The lossiness fix. A customer attribute nobody modelled must arrive, or
    // this representation has the same defect as the one it replaces. It has
    // to type-check too: an index signature on every attribute type is what
    // stops the compiler re-imposing the allow-list.
    const span: GenAiSpan = {
      trace_id: "t",
      start_time: "2026-08-04T22:14:34Z",
      attributes: {
        gen_ai: {
          operation: { name: "chat" },
          vendor_specific: { nested: "kept" },
        },
      },
    };

    expect(span.attributes.gen_ai?.vendor_specific).toEqual({
      nested: "kept",
    });
  });

  it("accepts an entirely unknown attribute family", () => {
    const span: GenAiSpan = {
      trace_id: "t",
      start_time: "2026-08-04T22:14:34Z",
      attributes: { acme: { tenant: "x" } },
    };

    expect(span.attributes.acme).toEqual({ tenant: "x" });
  });

  it("round-trips unknown attributes through serialization", () => {
    // Surviving the type is not enough — it has to come back out.
    const span: GenAiSpan = {
      trace_id: "t",
      start_time: "2026-08-04T22:14:34Z",
      attributes: {
        gen_ai: { vendor_specific: "kept", usage: { custom_tokens: 7 } },
        introspection: { tenant_tier: "gold" },
        acme: { a: 1 },
      },
    };

    const wire = JSON.parse(JSON.stringify(span));

    expect(wire.attributes.gen_ai.vendor_specific).toBe("kept");
    expect(wire.attributes.gen_ai.usage.custom_tokens).toBe(7);
    expect(wire.attributes.introspection.tenant_tier).toBe("gold");
    expect(wire.attributes.acme).toEqual({ a: 1 });
  });

  it("keeps the resource tree open too", () => {
    const span: GenAiSpan = {
      trace_id: "t",
      start_time: "2026-08-04T22:14:34Z",
      resource: {
        service: { name: "coding-agent", version: "1.2.3" },
        "host.arch": "arm64",
      },
      attributes: {},
    };

    expect(span.resource?.service?.name).toBe("coding-agent");
    expect(span.resource?.service?.version).toBe("1.2.3");
    expect(span.resource?.["host.arch"]).toBe("arm64");
  });
});

describe("convenience accessors", () => {
  it("reaches the messages without walking the tree", () => {
    expect(genAiConversationId(FULL_SPAN)).toBe(
      "019fcee7-4fcc-7793-a1ce-8047b3518303",
    );
    expect(genAiInputMessages(FULL_SPAN)[0].role).toBe("user");
    expect(genAiOutputMessages(FULL_SPAN)[0].finish_reason).toBe("stop");
  });

  it("returns empty rather than throwing on a bare span", () => {
    // A tool span carries no messages at all; reaching for them is normal and
    // must not require four levels of optional chaining at the call site.
    expect(genAiInputMessages(BARE_SPAN)).toEqual([]);
    expect(genAiOutputMessages(BARE_SPAN)).toEqual([]);
    expect(genAiConversationId(BARE_SPAN)).toBeUndefined();
  });
});

describe("one shape, three message depths", () => {
  it("parses a one-message preview and a full history with the same type", () => {
    // The list read sends one message; the item detail sends the whole
    // conversation so it can be resumed. Same type either way — if this ever
    // needed two types, the "one parser" claim would be false.
    for (const count of [1, 12]) {
      const span: GenAiSpan = {
        trace_id: "t",
        start_time: "2026-08-04T22:14:34Z",
        attributes: {
          gen_ai: {
            input: {
              messages: Array.from({ length: count }, (_, i) => ({
                role: "user" as const,
                parts: [{ type: "text" as const, content: `m${i}` }],
              })),
            },
          },
        },
      };

      expect(genAiInputMessages(span)).toHaveLength(count);
    }
  });

  it("keeps cursor pagination on the items envelope", () => {
    const page: GenAiSpanList = {
      object: "list",
      data: [FULL_SPAN],
      first_id: "caa8ff6f77084ded",
      last_id: "caa8ff6f77084ded",
      has_more: true,
      next: "cursor-abc",
    };

    expect(page.has_more).toBe(true);
    expect(page.next).toBe("cursor-abc");
    expect(page.data[0].attributes.gen_ai?.operation?.name).toBe("chat");
  });
});
