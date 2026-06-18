"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FlowLog } from "@/components/flow-log";
import {
  type Append,
  APPLICATION_TYPE,
  IDP_ISSUER,
  IDP_PROVIDER,
  IDP_PROVIDER_LABEL,
  type LogLine,
  brokerSession,
  runTaskWithToken,
  type RunSession,
} from "@/lib/intro";
import { createSupabaseBrowserClient } from "@/lib/supabase";

/**
 * JWKS — bring your own IdP (the `jwks` application type).
 *
 * Sign in at the partner IdP (Supabase) headlessly — reuse a live session or
 * signInWithPassword — then the broker runs the RFC 8693 token-exchange on the
 * session access token (CP verifies it against the issuer's JWKS), the DP
 * exchange sets the HttpOnly intro_dp_session cookie, and the page creates a
 * task and streams its events — the same tail as every other mode. No Zitadel
 * redirect, no consent page, no Introspection UI.
 */
export default function DirectPage() {
  const [email, setEmail] = useState("user@example.com");
  const [password, setPassword] = useState("");
  const [prompt, setPrompt] = useState(
    "Use the partner MCP to remember that my favorite color is teal, " +
      "then read it back to me.",
  );
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const socketRef = useRef<RunSession | null>(null);

  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

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
      if (!supabase) {
        throw new Error(
          "Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (and optionally NEXT_PUBLIC_SUPABASE_URL) for the direct sign-in",
        );
      }
      append(
        "info",
        `Signing in at ${IDP_PROVIDER_LABEL[IDP_PROVIDER]} directly (no redirect, no consent) …`,
      );
      let session = (await supabase.auth.getSession()).data.session;
      if (session) {
        append("ok", "   ✓ reused the existing Supabase session");
      } else {
        const result = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (result.error) throw new Error(result.error.message);
        session = result.data.session;
        append("ok", "   ✓ signed in to Supabase");
      }
      if (!session) throw new Error("Supabase sign-in returned no session");

      append(
        "info",
        `Broker exchanging the ${IDP_PROVIDER_LABEL[IDP_PROVIDER]} access token (token-exchange) …`,
      );
      const { token } = await brokerSession("federated", session.access_token);
      append("ok", "   ✓ Introspection token minted");

      socketRef.current = await runTaskWithToken({
        token,
        prompt,
        append,
      });
    } catch (err) {
      append("err", `✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }, [append, email, password, prompt, supabase]);

  const canRun = !running && email.trim().length > 0 && password.length > 0;

  return (
    <main>
      <h1>JWKS — sign in with your own IdP</h1>
      <p className="subtitle">
        A <code>jwks</code> application: your IdP&apos;s own JWT is the
        token-exchange subject_token, verified at the Control Plane against the
        issuer&apos;s JWKS. No Zitadel, no consent page — the page then creates
        a task and streams its events. <Link href="/">← all modes</Link>
      </p>

      <div className="card">
        <div className="step">Sign in &amp; run a task</div>
        <p className="field-help">
          Expected issuer: <code>{IDP_ISSUER || "(unset)"}</code> · verified
          against its JWKS at the Control Plane.
        </p>
        {APPLICATION_TYPE !== "jwks" && (
          <p className="field-help">
            ⚠ This federation is on an <code>{APPLICATION_TYPE}</code>{" "}
            application — create a <code>jwks</code> application and set{" "}
            <code>NEXT_PUBLIC_APPLICATION_TYPE=jwks</code> for this page to
            exchange successfully (see the README).
          </p>
        )}
        <label htmlFor="supabase-email">
          {IDP_PROVIDER_LABEL[IDP_PROVIDER]} email
        </label>
        <input
          id="supabase-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="supabase-password">
          {IDP_PROVIDER_LABEL[IDP_PROVIDER]} password
        </label>
        <input
          id="supabase-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="field-help">
          A live {IDP_PROVIDER_LABEL[IDP_PROVIDER]} session is reused — the
          credentials are only needed for the first sign-in.
        </p>
        <label htmlFor="task-prompt">Task prompt</label>
        <input
          id="task-prompt"
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <div className="inline-actions">
          <button onClick={run} disabled={!canRun}>
            {running ? "Running…" : "Sign in & run task"}
          </button>
        </div>
        <p className="field-help">
          On success the <code>intro_dp_session</code> cookie is set, a task is
          created at the Data Plane, and its event stream renders below.
        </p>
      </div>

      <FlowLog log={log} />
    </main>
  );
}
