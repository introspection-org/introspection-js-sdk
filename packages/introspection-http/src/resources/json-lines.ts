/** The non-blank lines of a byte stream, each whole however the chunks split it. */
async function* readLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = done ? "" : (lines.pop() ?? "");
      for (const line of lines) if (line.trim() !== "") yield line;
      if (done) return;
    }
  } finally {
    // A consumer that stops early must not leave the response body open.
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * The values of an `application/x-ndjson` body, parsed one line at a time as
 * the response arrives, so the body is never buffered whole.
 */
export async function* readJsonLines<T>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  for await (const line of readLines(body)) yield JSON.parse(line) as T;
}
