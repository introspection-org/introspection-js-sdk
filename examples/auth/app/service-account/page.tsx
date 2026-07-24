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
 * session has project access but no federated end-user identity.
 */
export default function ServiceAccountPage() {
  const [prompt, setPrompt] = useState(
    "Use the partner MCP to remember that my favorite color is amber, " +
      "then read it back to me.",
  );
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
      const { token, runtime, dpUrl } = await brokerSession({
        mode: "service_account",
      });
      append("ok", `   ✓ token minted for Runtime ${runtime}`);
      socketRef.current = await runTaskWithToken(dpUrl, {
        token,
        runtime,
        prompt,
        append,
      });
    } catch (err) {
      append("err", `✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }, [append, prompt]);

  return (
    <main>
      <h1>Service account — machine token</h1>
      <p className="subtitle">
        No end users: the broker mints a machine token via{" "}
        <code>client_credentials</code> (the secret never reaches the browser).
        Project-scoped machine authority, with no end-user identity.{" "}
        <Link href="/">← all modes</Link>
      </p>

      <div className="card">
        <div className="step">Run as the machine</div>
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
