import { EventSchemas, type AGUIEvent } from "@ag-ui/core";

export interface StreamFrame {
  name: string;
  data: string;
  id?: string;
  retry?: number;
}

/** The fields of the frame being read, until a blank line ends it. */
interface FrameDraft {
  name: string;
  data: string[];
  id?: string;
  retry?: number;
}

const emptyDraft = (): FrameDraft => ({ name: "message", data: [] });

/**
 * End the frame in `draft` and reset it. An empty draft yields no frame and
 * keeps its `retry`.
 */
function flushDraft(draft: FrameDraft): StreamFrame | null {
  if (
    draft.data.length === 0 &&
    draft.name === "message" &&
    draft.id === undefined
  ) {
    return null;
  }
  const frame: StreamFrame = { name: draft.name, data: draft.data.join("\n") };
  if (draft.id !== undefined) frame.id = draft.id;
  if (draft.retry !== undefined) frame.retry = draft.retry;
  draft.name = "message";
  draft.data = [];
  draft.id = undefined;
  draft.retry = undefined;
  return frame;
}

/** Apply one non-blank stream line to `draft`; comment lines are ignored. */
function applyLine(draft: FrameDraft, line: string): void {
  if (line.startsWith(":")) return;
  const colon = line.indexOf(":");
  const field = colon < 0 ? line : line.slice(0, colon);
  const valueRaw = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
  if (field === "event") draft.name = valueRaw;
  else if (field === "data") draft.data.push(valueRaw);
  else if (field === "id") draft.id = valueRaw;
  else if (field === "retry") {
    const n = Number(valueRaw);
    if (Number.isFinite(n)) draft.retry = n;
  }
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
  const draft = emptyDraft();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line !== "") {
          applyLine(draft, line);
          continue;
        }
        const frame = flushDraft(draft);
        if (frame) yield frame;
      }
    }
    // Anything still in `buf` at EOF is a frame with no terminating blank
    // line. SSE says to discard it, and it used to be flushed instead:
    // half a JSON payload reaches `parseAgUiEvents`, which throws a bare
    // SyntaxError that `streamResumable` then misreads as a transport drop.
  } finally {
    // Without this, a consumer that `break`s out of the `for await` (a UI
    // that stops at the first answer) leaves the reader locked and the
    // response body open: one leaked connection per run.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
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
