"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import {
  type Append,
  CP_URL,
  type LogLine,
  SPA_CLIENT_ID,
  ZITADEL_ISSUER_URL,
  runTaskWithToken,
  type RunSession,
} from "@/lib/intro";

const SPA_FLOW_KEY = "intro_spa_flow";
const FEDERATED_FLOW_KEY = "intro_federated_flow";
const FEDERATED_TOKEN_KEY = "intro_federated_subject_token";

interface SpaFlow {
  verifier: string;
  state: string;
  prompt: string;
}

interface FederatedFlow {
  verifier: string;
  state: string;
}

/**
 * OAuth redirect callback shared by the redirecting modes:
 *
 *  - hosted login (/spa, no brokered IdP) — completes the authorization_code +
 *    PKCE flow: validate state, exchange the code for an Introspection token,
 *    then run the shared task tail here.
 *  - brokered (/spa, brokered IdP configured) — exchanges the customers-org
 *    code for an id_token, stashes it in sessionStorage, and returns to /spa.
 */
export default function Callback() {
  const [log, setLog] = useState<LogLine[]>([]);
  const socketRef = useRef<RunSession | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return; // StrictMode double-invoke guard
    startedRef.current = true;

    const append: Append = (kind, text) =>
      setLog((prev) => [...prev, { kind, text }]);

    const complete = async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const code = params.get("code");
        const state = params.get("state");
        const error = params.get("error");
        if (error) throw new Error(`Authorization failed: ${error}`);
        if (!code || !state)
          throw new Error("Missing code or state in callback");

        const spaStored = sessionStorage.getItem(SPA_FLOW_KEY);
        if (spaStored) {
          const flow = JSON.parse(spaStored) as SpaFlow;
          sessionStorage.removeItem(SPA_FLOW_KEY);
          if (state !== flow.state)
            throw new Error("State mismatch — possible CSRF");

          append("ok", "   ✓ returned from Introspection login");
          append("info", "Exchanging the authorization code (PKCE) …");
          const form = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: `${window.location.origin}/callback`,
            client_id: SPA_CLIENT_ID,
            code_verifier: flow.verifier,
          });
          const res = await fetch(`${CP_URL}/v1/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString(),
          });
          if (!res.ok) throw new Error(`token exchange returned ${res.status}`);
          const { access_token } = (await res.json()) as {
            access_token: string;
          };
          append("ok", "   ✓ Introspection token minted");

          socketRef.current = await runTaskWithToken({
            token: access_token,
            prompt: flow.prompt,
            append,
          });
          return;
        }

        const federatedStored = sessionStorage.getItem(FEDERATED_FLOW_KEY);
        if (!federatedStored)
          throw new Error("No pending auth flow (state lost)");
        const flow = JSON.parse(federatedStored) as FederatedFlow;
        sessionStorage.removeItem(FEDERATED_FLOW_KEY);
        if (state !== flow.state)
          throw new Error("State mismatch — possible CSRF");

        append("ok", "   ✓ returned from brokered Zitadel login");
        append(
          "info",
          "Exchanging the customers-org authorization code for an id_token …",
        );
        const res = await fetch("/api/brokered-idp/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            code_verifier: flow.verifier,
            redirect_uri: `${window.location.origin}/callback`,
          }),
        });
        if (!res.ok) {
          throw new Error(`brokered token exchange returned ${res.status}`);
        }
        const { id_token } = (await res.json()) as { id_token: string };
        sessionStorage.setItem(FEDERATED_TOKEN_KEY, id_token);
        append("ok", "   ✓ brokered Zitadel id_token captured");
        append(
          "info",
          `Returning to the spa page (issuer ${ZITADEL_ISSUER_URL}) …`,
        );
        window.location.replace("/spa");
      } catch (err) {
        append("err", `✗ ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    void complete();
    return () => socketRef.current?.close();
  }, []);

  return (
    <main>
      <h1>Introspection — login callback</h1>
      <p className="subtitle">
        Completing the redirect flow (hosted login or brokered sign-in).{" "}
        <Link href="/">← all modes</Link>
      </p>
      <div className="card">
        <div className="step">Flow</div>
        <div className="log">
          {log.length === 0 ? (
            <p className="log-line log-muted">Working…</p>
          ) : (
            log.map((line, i) => (
              <p
                key={i}
                className={`log-line ${
                  line.kind === "ok"
                    ? "log-ok"
                    : line.kind === "err"
                      ? "log-err"
                      : "log-muted"
                }`}
              >
                {line.text}
              </p>
            ))
          )}
        </div>
      </div>
    </main>
  );
}
