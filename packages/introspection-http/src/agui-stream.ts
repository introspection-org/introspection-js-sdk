import { EventSchemas, type AGUIEvent } from "@ag-ui/core";

export interface StreamFrame {
  name: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Parse the HTTP stream transport frames. Package-internal: the public task
 * streaming surface yields AG-UI events, but the resumable consumer
 * (`resumable.ts`) needs the frame `id` to track its `Last-Event-ID` resume
 * cursor, so this is exported within the package (not re-exported publicly).
 */
export async function* parseStreamFrames(
  res: Response,
): AsyncIterable<StreamFrame> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let name = "message";
  let data: string[] = [];
  let id: string | undefined;
  let retry: number | undefined;
  const flush = (): StreamFrame | null => {
    if (data.length === 0 && name === "message" && id === undefined) {
      return null;
    }
    const frame: StreamFrame = { name, data: data.join("\n") };
    if (id !== undefined) frame.id = id;
    if (retry !== undefined) frame.retry = retry;
    name = "message";
    data = [];
    id = undefined;
    retry = undefined;
    return frame;
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
        const frame = flush();
        if (frame) yield frame;
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const valueRaw = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") name = valueRaw;
      else if (field === "data") data.push(valueRaw);
      else if (field === "id") id = valueRaw;
      else if (field === "retry") {
        const n = Number(valueRaw);
        if (Number.isFinite(n)) retry = n;
      }
    }
  }
  const frame = flush();
  if (frame) yield frame;
}

/**
 * Parse the task run stream into AG-UI protocol events. The task stream uses
 * HTTP stream frames as transport only: `ag_ui` carries one AG-UI JSON event
 * in `data`, while transport frames such as `heartbeat` are ignored.
 */
export async function* parseAgUiEvents(
  res: Response,
): AsyncIterable<AGUIEvent> {
  for await (const frame of parseStreamFrames(res)) {
    if (frame.name !== "ag_ui") continue;
    const payload = JSON.parse(frame.data) as unknown;
    yield EventSchemas.parse(payload);
  }
}
