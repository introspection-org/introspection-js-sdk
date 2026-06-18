"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { FlowLog } from "@/components/flow-log";
import {
  type Append,
  type LogLine,
  brokerSession,
  runTaskWithToken,
  type RunSession,
} from "@/lib/intro";

/**
 * Service account — no end users (server / CI). The broker route
 * (/api/broker/session) authenticates the machine itself via
 * client_credentials, keeping the client secret server-side; the resulting
 * session has project access but no federated end-user identity. The task
 * instead carries a caller-asserted identity via `metadata.identity`
 * which the platform turns into the ATTRIBUTION rung of the partner
 * MCP assertion: `sub: user:{user_id}`,
 * `sub_type: "identity"`, hard-distinct `type: "identity_attribution"` —
 * the sample MCP surfaces all of it in its tool responses.
 */
export default function ServiceAccountPage() {
  const [prompt, setPrompt] = useState(
    "Use the partner MCP to remember that my favorite color is amber, " +
      "then read it back to me.",
  );
  const [userId, setUserId] = useState("sa-demo-user");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const socketRef = useRef<RunSession | null>(null);

  const append = useCallback<Append>((kind, text) => {
    setLog((prev) => [...prev, { kind, text }]);
  }, []);

  useEffect(() => {
    return () => socketRef.current?.close();
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setLog([]);
    socketRef.current?.close();
    try {
      append(
        "info",
        "Broker authenticating the service account (client credentials) …",
      );
      const { token } = await brokerSession("service_account");
      append("ok", "   ✓ Introspection token minted");
      const trimmedUserId = userId.trim();
      socketRef.current = await runTaskWithToken({
        token,
        prompt,
        append,
        // Caller-asserted attribution identity: becomes the task's
        // metadata.identity, and the attribution-rung MCP assertion's
        // `sub: user:{user_id}`.
        ...(trimmedUserId ? { identity: { user_id: trimmedUserId } } : {}),
      });
    } catch (err) {
      append("err", `✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }, [append, prompt, userId]);

  return (
    <main>
      <h1>Service account — machine token</h1>
      <p className="subtitle">
        No end users: the broker mints a machine token via{" "}
        <code>client_credentials</code> (the secret never reaches the browser).
        Project access; identity is caller-asserted via{" "}
        <code>metadata.identity</code> — the attribution rung (
        <code>type: identity_attribution</code>).{" "}
        <Link href="/">← all modes</Link>
      </p>

      <div className="card">
        <div className="step">Run as the machine</div>
        <label htmlFor="user-id">Attributed user id</label>
        <input
          id="user-id"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="sa-demo-user"
        />
        <label htmlFor="prompt">Prompt</label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button onClick={run} disabled={running}>
          {running ? "Running…" : "Run this mode"}
        </button>
      </div>

      <FlowLog log={log} />
    </main>
  );
}
