"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase";

interface ConsentDetails {
  redirect_url?: string;
}

type ConsentState =
  | { status: "working"; message: string }
  | { status: "error"; message: string };

/**
 * Headless consent hop for the brokered sign-in flow.
 *
 * With a live Supabase session this page completes the OAuth dance
 * without user interaction: it resolves the authorization request and
 * auto-approves it, then follows the redirect back to Zitadel. No
 * profile data is read from or written to Supabase — Zitadel's
 * brokered onboarding tolerates partial profiles (sub-only), so the
 * sample never touches user metadata. The only UI ever rendered is the
 * sign-in fallback when no Supabase session exists.
 */
export function SupabaseConsentClient() {
  const [state, setState] = useState<ConsentState>({
    status: "working",
    message: "Continuing brokered sign-in …",
  });
  const [submitting, setSubmitting] = useState(false);
  const [email, setEmail] = useState("user@example.com");
  const [password, setPassword] = useState("");
  const [authMessage, setAuthMessage] = useState<string | null>(null);

  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const approveAndRedirect = useCallback(
    async (authorizationId: string) => {
      if (!supabase) return;

      const oauthClient = (
        supabase.auth as unknown as {
          oauth: Record<string, (...args: unknown[]) => Promise<unknown>>;
        }
      ).oauth;

      const details = (await oauthClient.getAuthorizationDetails(
        authorizationId,
      )) as {
        data?: ConsentDetails;
        error?: { message?: string } | null;
      };
      if (details.error) {
        throw new Error(
          details.error.message ??
            "Supabase rejected the authorization details lookup.",
        );
      }

      // Already approved (e.g. a previous grant) — just follow it.
      if (details.data?.redirect_url) {
        window.location.assign(details.data.redirect_url);
        return;
      }

      const approval = (await oauthClient.approveAuthorization(
        authorizationId,
      )) as {
        data?: { redirect_url?: string };
        error?: { message?: string } | null;
      };
      if (approval.error) {
        throw new Error(
          approval.error.message ?? "Supabase could not approve the request.",
        );
      }
      if (!approval.data?.redirect_url) {
        throw new Error(
          "Supabase approved the request but returned no redirect_url.",
        );
      }

      window.location.assign(approval.data.redirect_url);
    },
    [supabase],
  );

  useEffect(() => {
    const authorizationId =
      new URLSearchParams(window.location.search).get("authorization_id") ?? "";

    if (!authorizationId) {
      setState({
        status: "error",
        message: "Missing authorization_id in the Supabase consent redirect.",
      });
      return;
    }

    if (!supabase) {
      setState({
        status: "error",
        message:
          "Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (and optionally NEXT_PUBLIC_SUPABASE_URL) so this page can talk to Supabase.",
      });
      return;
    }

    const load = async () => {
      const session = await supabase.auth.getSession();
      if (!session.data.session) {
        setState({
          status: "error",
          message: "Auth session missing!",
        });
        return;
      }

      await approveAndRedirect(authorizationId);
    };

    void load().catch((error: unknown) => {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, [supabase, approveAndRedirect]);

  const signIn = async () => {
    if (!supabase) return;
    const authorizationId =
      new URLSearchParams(window.location.search).get("authorization_id") ?? "";
    if (!authorizationId) return;

    setSubmitting(true);
    setAuthMessage(null);
    try {
      const result = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (result.error) {
        throw new Error(result.error.message);
      }
      setState({
        status: "working",
        message: "Signed in to Supabase. Continuing brokered sign-in …",
      });
      await approveAndRedirect(authorizationId);
    } catch (error) {
      setAuthMessage(error instanceof Error ? error.message : String(error));
      setSubmitting(false);
    }
  };

  if (state.status === "working") {
    return (
      <div className="card">
        <p className="field-help">{state.message}</p>
      </div>
    );
  }

  const needsSession = state.message === "Auth session missing!";
  return (
    <div className="card">
      <p className="consent-error">{state.message}</p>
      {needsSession ? (
        <>
          <p className="field-help">
            Sign in to Supabase first; the brokered sign-in then completes
            automatically with no further prompts.
          </p>
          <label htmlFor="supabase-email">Supabase email</label>
          <input
            id="supabase-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <label htmlFor="supabase-password">Supabase password</label>
          <input
            id="supabase-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <div className="inline-actions">
            <button onClick={signIn} disabled={submitting}>
              {submitting ? "Signing in …" : "Sign in to Supabase"}
            </button>
          </div>
          {authMessage ? <p className="field-help">{authMessage}</p> : null}
        </>
      ) : null}
    </div>
  );
}
