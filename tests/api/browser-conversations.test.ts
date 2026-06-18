import { describe, expect, it, vi } from "vitest";
import {
  BrowserHttpClient,
  ConversationsClient,
  ConversationItemsClient,
  IntrospectionApiClient,
} from "@introspection-sdk/introspection-browser/api";

// Browser Conversations client unit tests. The DP `http` is injected, so
// no network boundary is crossed (AGENTS.md §6 case 1).

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
    stream: vi.fn().mockResolvedValue(overrides.streamResult ?? new Response()),
  } as unknown as BrowserHttpClient;
}

const SUMMARY_FIXTURE = {
  conversation_id: "conv-1",
  created_at: "2025-01-01T00:00:00Z",
};

describe("browser ConversationsClient", () => {
  it("list() walks /v1/conversations with the cursor envelope", async () => {
    const http = mockHttp({
      requestResult: { records: [SUMMARY_FIXTURE], count: 1, next: null },
    });
    const conversations = new ConversationsClient(http);
    const page = await conversations.list({ limit: 10 });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations",
      query: { limit: 10, next: undefined },
    });
    expect(page.records).toHaveLength(1);
  });

  it("items.list() drives the OpenAI-style `after` cursor across pages", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: "item-1" }],
        has_more: true,
        last_id: "item-1",
      })
      .mockResolvedValueOnce({
        data: [{ id: "item-2" }],
        has_more: false,
        last_id: "item-2",
      });
    const http = { request } as unknown as BrowserHttpClient;
    const items = new ConversationItemsClient(http);

    const ids: string[] = [];
    for await (const it of items.list("conv-1", { order: "asc" })) {
      ids.push(it.id);
    }

    expect(ids).toEqual(["item-1", "item-2"]);
    expect(request).toHaveBeenCalledTimes(2);
    // second page is fetched with after = previous page's last_id
    expect(request.mock.calls[1][0].query.after).toBe("item-1");
  });

  it("items.get() reads a single item with includes", async () => {
    const http = mockHttp({ requestResult: { id: "item-1" } });
    const items = new ConversationItemsClient(http);
    await items.get("conv-1", "item-1", {
      include: ["gen_ai.input.messages"],
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations/conv-1/items/item-1",
      query: { include: ["gen_ai.input.messages"] },
    });
  });

  it("retrieve(id, itemId) resolves a turn into a ConversationResponse", async () => {
    const http = mockHttp({
      requestResult: {
        id: "item-9",
        created_at: "2025-01-01T00:00:00Z",
        response_id: "resp-1",
        model_name: "gpt-4o",
        provider_name: "openai",
        input_messages: [],
        output_message: { parts: [{ type: "text", content: "hi" }] },
        system_instructions: null,
        tool_definitions: null,
      },
    });
    const conversations = new ConversationsClient(http);
    const res = await conversations.retrieve("conv-1", "item-9");

    expect(res).not.toBeNull();
    expect(res?.conversation_id).toBe("conv-1");
    expect(res?.item_id).toBe("item-9");
    expect(res?.model).toBe("gpt-4o");
    expect(res?.output_messages).toHaveLength(1);
    // the single-item route was hit with the response includes
    const call = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.path).toBe("/v1/conversations/conv-1/items/item-9");
    expect(call.query.include).toContain("gen_ai.input.messages");
  });

  it("retrieve() returns null for an empty conversation", async () => {
    // items.list() yields nothing -> no latest turn -> null
    const http = mockHttp({
      requestResult: { data: [], has_more: false, last_id: null },
    });
    const conversations = new ConversationsClient(http);
    const res = await conversations.retrieve("conv-empty");
    expect(res).toBeNull();
  });

  it("is exposed on IntrospectionApiClient.conversations", () => {
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      projectId: "proj-1",
      getToken: () => "token",
      fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(client.conversations).toBeInstanceOf(ConversationsClient);
  });
});
