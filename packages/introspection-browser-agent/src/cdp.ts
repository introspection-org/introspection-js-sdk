/**
 * A minimal Chrome DevTools Protocol client over the platform WebSocket.
 *
 * One browser-level connection, with page targets attached in flatten mode so
 * every tab shares the socket and is addressed by `sessionId`. Nothing here
 * knows about pages or elements; that is `session.ts`.
 */

export interface CdpError extends Error {
  code?: number;
  method: string;
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  method: string;
};

export interface CdpConnectOptions {
  /** Sent on the WebSocket upgrade: `Authorization` for the browser edge. */
  headers?: Record<string, string>;
  /** Per-command timeout. */
  timeoutMs?: number;
}

/**
 * Accepts the WebSocket URL itself (`ws://…/devtools/browser/…`, or an
 * edge `wss://…/cdp`), or an HTTP endpoint whose `/json/version` names it.
 */
export async function resolveCdpUrl(
  endpoint: string,
  headers?: Record<string, string>,
): Promise<string> {
  if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) {
    return endpoint;
  }
  const url = new URL("/json/version", endpoint);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`CDP discovery failed: ${res.status} from ${url}`);
  }
  const body = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!body.webSocketDebuggerUrl) {
    throw new Error(`CDP discovery at ${url} returned no webSocketDebuggerUrl`);
  }
  return body.webSocketDebuggerUrl;
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private closedError: Error | null = null;

  private constructor(
    private readonly socket: WebSocket,
    private readonly timeoutMs: number,
  ) {
    socket.addEventListener("message", (ev) => this.onMessage(ev));
    socket.addEventListener("close", () =>
      this.failAll(new Error("CDP connection closed")),
    );
  }

  static async connect(
    endpoint: string,
    options: CdpConnectOptions = {},
  ): Promise<CdpConnection> {
    const url = await resolveCdpUrl(endpoint, options.headers);
    // Node's WebSocket (undici) takes `headers` in its init; browsers do not.
    const socket = new WebSocket(url, {
      headers: options.headers,
    } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener(
        "error",
        () => reject(new Error(`CDP connection to ${url} failed`)),
        { once: true },
      );
    });
    return new CdpConnection(socket, options.timeoutMs ?? 30_000);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.socket.send(JSON.stringify(message));
    });
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves with the first event matching `predicate`, or rejects on timeout. */
  waitFor(
    predicate: (event: CdpEvent) => boolean,
    timeoutMs: number,
  ): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const off = this.on((event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        off();
        resolve(event);
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  close(): void {
    this.socket.close();
  }

  private onMessage(ev: MessageEvent): void {
    const data = JSON.parse(String(ev.data)) as {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    if (data.id !== undefined) {
      const entry = this.pending.get(data.id);
      if (!entry) return;
      this.pending.delete(data.id);
      if (data.error) {
        const err = new Error(
          `CDP ${entry.method}: ${data.error.message}`,
        ) as CdpError;
        err.code = data.error.code;
        err.method = entry.method;
        entry.reject(err);
      } else {
        entry.resolve(data.result ?? {});
      }
      return;
    }
    if (data.method) {
      const event: CdpEvent = {
        method: data.method,
        params: data.params ?? {},
        sessionId: data.sessionId,
      };
      for (const listener of this.listeners) listener(event);
    }
  }

  private failAll(err: Error): void {
    this.closedError = err;
    for (const entry of this.pending.values()) entry.reject(err);
    this.pending.clear();
  }
}
