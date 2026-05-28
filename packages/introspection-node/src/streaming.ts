import type { SseEvent } from "@introspection-sdk/types";

/**
 * Parse a `text/event-stream` Response into an async-iterable of SSE
 * events. Minimal parser: handles `event:`, `data:` (multi-line),
 * `id:`, `retry:`; ignores comments and unknown fields.
 */
export async function* parseSse(res: Response): AsyncIterable<SseEvent> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "message";
  let data: string[] = [];
  let id: string | undefined;
  let retry: number | undefined;
  const flush = (): SseEvent | null => {
    if (data.length === 0 && event === "message" && id === undefined)
      return null;
    const ev: SseEvent = { event, data: data.join("\n") };
    if (id !== undefined) ev.id = id;
    if (retry !== undefined) ev.retry = retry;
    event = "message";
    data = [];
    id = undefined;
    retry = undefined;
    return ev;
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        const ev = flush();
        if (ev) yield ev;
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const valueRaw = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = valueRaw;
      else if (field === "data") data.push(valueRaw);
      else if (field === "id") id = valueRaw;
      else if (field === "retry") {
        const n = Number(valueRaw);
        if (Number.isFinite(n)) retry = n;
      }
    }
  }
  const ev = flush();
  if (ev) yield ev;
}
