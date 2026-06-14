/**
 * Browser-side Supabase helpers shared by the JWKS federated sign-in
 * (app/jwks/page.tsx) and the brokered consent hop
 * (app/oauth/consent/supabase-consent-client.tsx).
 *
 * The project URL falls back to the IdP issuer with the `/auth/v1` suffix
 * stripped, so a seeded `.env.local` needs only the issuer + publishable key.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export function supabaseProjectUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const issuer = process.env.NEXT_PUBLIC_IDP_ISSUER?.trim() ?? "";
  return issuer.replace(/\/auth\/v1\/?$/, "");
}

export function publishableKey(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
}

/**
 * A browser Supabase client, or null when the project URL / publishable key
 * env vars are missing (callers render a setup hint instead).
 */
export function createSupabaseBrowserClient(): SupabaseClient | null {
  const url = supabaseProjectUrl();
  const key = publishableKey();
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: true,
    },
  });
}
