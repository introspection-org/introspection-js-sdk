"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { FlowLog } from "@/components/flow-log";
import {
  type Append,
  BROKERED_AUDIENCE_CLIENT_ID,
  BROKERED_EXTERNAL_ORG_ID,
  CP_URL,
  IDP_PROVIDER,
  IDP_PROVIDER_LABEL,
  type LogLine,
  PROJECT_ID,
  SPA_CLIENT_ID,
  ZITADEL_ISSUER_URL,
  brokerSession,
  generatePkce,
  randomToken,
  runTaskWithToken,
  type RunSession,
} from "@/lib/intro";

/** Persisted across the redirect (sessionStorage). */
const SPA_FLOW_KEY = "intro_spa_flow";
const FEDERATED_FLOW_KEY = "intro_federated_flow";
const FEDERATED_TOKEN_KEY = "intro_federated_subject_token";

interface FederatedFlow {
  verifier: string;
  state: string;
}

/**
 * The `spa` application — Introspection's hosted authorization_code + PKCE
 * login. When the spa app has a brokered IdP configured (the customer's own
 * IdP federated through a per-app Zitadel customers org), this page brokers
 * that login; otherwise it falls back to Introspection's own hosted login.
 * Both are the same OAuth redirect flow against the same `spa` client — only
 * the authorization server differs. `/callback` resumes whichever ran.
 */
export default function SpaPage() {
  // A brokered IdP is "set up for the spa" when a per-app customers org
  // (audience + org id) has been provisioned. Otherwise fall back to the
  // default Introspection hosted login.
  const brokered = Boolean(
    BROKERED_AUDIENCE_CLIENT_ID && BROKERED_EXTERNAL_ORG_ID,
  );

  // Mirrors the /jwks page: a hosted-login (spa) member exercises the same
  // partner-MCP loop, authenticating on the member rung (sub_type "member").
  const [prompt, setPrompt] = useState(
    "Use the partner MCP to remember that my favorite color is teal, " +
      "then read it back to me.",
  );
  const [subjectToken, setSubjectToken] = useState("");
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const socketRef = useRef<RunSession | null>(null);

  const append = useCallback<Append>((kind, text) => {
    setLog((prev) => [...prev, { kind, text }]);
  }, []);

  useEffect(() => {
    return () => socketRef.current?.close();
  }, []);

  // Brokered flow: /callback stashes the captured customers-org id_token here.
  useEffect(() => {
    const token = sessionStorage.getItem(FEDERATED_TOKEN_KEY);
    if (!token) return;
    setSubjectToken(token);
    sessionStorage.removeItem(FEDERATED_TOKEN_KEY);
  }, []);

  // Hosted login: redirect to Introspection's authorization endpoint; the
  // shared /callback exchanges the code and runs the task tail.
  const runHosted = useCallback(async () => {
    setRunning(true);
    setLog([]);
    try {
      if (!SPA_CLIENT_ID || !PROJECT_ID) {
        throw new Error(
          "Set NEXT_PUBLIC_INTROSPECTION_SPA_CLIENT_ID and _PROJECT_ID",
        );
      }
      append("info", "Redirecting to Introspection's hosted login …");
      const { verifier, challenge } = await generatePkce();
      const state = randomToken();
      sessionStorage.setItem(
        SPA_FLOW_KEY,
        JSON.stringify({ verifier, state, prompt }),
      );
      const params = new URLSearchParams({
        client_id: SPA_CLIENT_ID,
        redirect_uri: `${window.location.origin}/callback`,
        response_type: "code",
        state,
        scope: "*", // capped server-side to the app's allowed_scopes
        project_id: PROJECT_ID,
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      window.location.href = `${CP_URL}/v1/oauth/authorize?${params.toString()}`;
      // navigation leaves the page; /callback resumes the flow
    } catch (err) {
      append("err", `✗ ${err instanceof Error ? err.message : String(err)}`);
      setRunning(false);
    }
  }, [append, prompt]);

  // Brokered flow: redirect to the per-app customers Zitadel org; /callback
  // captures the id_token and returns here to exchange + run.
  const startBrokeredRedirect = useCallback(async () => {
    const { verifier, challenge } = await generatePkce();
    const state = randomToken();
    const scope = [
      "openid",
      "profile",
      "email",
      `urn:zitadel:iam:org:id:${BROKERED_EXTERNAL_ORG_ID}`,
    ].join(" ");
    sessionStorage.setItem(
      FEDERATED_FLOW_KEY,
      JSON.stringify({ verifier, state } satisfies FederatedFlow),
    );
    const params = new URLSearchParams({
      client_id: BROKERED_AUDIENCE_CLIENT_ID,
      redirect_uri: `${window.location.origin}/callback`,
      response_type: "code",
      scope,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "login",
    });
    window.location.href = `${ZITADEL_ISSUER_URL}/oauth/v2/authorize?${params.toString()}`;
  }, []);

  const runBrokered = useCallback(async () => {
    setRunning(true);
    setLog([]);
    socketRef.current?.close();
    try {
      const token = subjectToken.trim();
      if (!token) {
        throw new Error("Sign in via Zitadel first to capture an id_token");
      }
      append(
        "info",
        `Broker exchanging the ${IDP_PROVIDER_LABEL[IDP_PROVIDER]} id_token (token-exchange) …`,
      );
      const session = await brokerSession("federated", token);
      append("ok", "   ✓ Introspection token minted");
      socketRef.current = await runTaskWithToken({
        token: session.token,
        prompt,
        append,
      });
    } catch (err) {
      append("err", `✗ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }, [append, prompt, subjectToken]);

  return (
    <main>
      <h1>SPA — Introspection-hosted login</h1>
      <p className="subtitle">
        An <code>spa</code> application using Introspection&apos;s hosted
        authorization-code + PKCE login.{" "}
        {brokered
          ? `A brokered ${IDP_PROVIDER_LABEL[IDP_PROVIDER]} IdP is configured, so the login is brokered through a per-app Zitadel customers org.`
          : "No brokered IdP is configured, so this falls back to Introspection's own hosted login."}{" "}
        <Link href="/">← all modes</Link>
      </p>

      <div className="card">
        <div className="step">
          {brokered ? "Brokered sign-in" : "Hosted sign-in"}
        </div>

        {brokered ? (
          <>
            <p className="field-help">
              Brokered through <code>{ZITADEL_ISSUER_URL}</code>. Use the
              brokered {IDP_PROVIDER_LABEL[IDP_PROVIDER]} login, or paste a
              customers-org Zitadel <code>id_token</code> directly.
            </p>
            <div className="inline-actions">
              <button
                type="button"
                onClick={() => void startBrokeredRedirect()}
              >
                Sign in via Zitadel
              </button>
              <span className="field-help">
                Starts the brokered login and fills this field on return.
              </span>
            </div>
            <label htmlFor="subject_token">
              Brokered IdP id_token (subject_token)
            </label>
            <textarea
              id="subject_token"
              placeholder="eyJ…"
              value={subjectToken}
              onChange={(e) => setSubjectToken(e.target.value)}
            />
          </>
        ) : null}

        <label htmlFor="prompt">Prompt</label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button
          onClick={brokered ? runBrokered : runHosted}
          disabled={running || (brokered && subjectToken.trim().length === 0)}
        >
          {running
            ? brokered
              ? "Running…"
              : "Redirecting…"
            : brokered
              ? "Exchange & run"
              : "Sign in & run"}
        </button>
      </div>

      <FlowLog log={log} />
    </main>
  );
}
