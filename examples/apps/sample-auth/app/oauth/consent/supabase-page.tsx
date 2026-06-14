import { SupabaseConsentClient } from "./supabase-consent-client";

export function SupabaseConsentPage() {
  return (
    <main>
      <h1>Approve Supabase access</h1>
      <p className="subtitle">
        Supabase sent the browser here to confirm the brokered login request.
      </p>
      <SupabaseConsentClient />
    </main>
  );
}
