/** Direct Sign-In on Flight Sector's own page (spec 4.2): Sam is signed in already, and chooses what Atlas may do. */
import { redirect } from "next/navigation";

import { PoppyError } from "@/lib/company/errors";
import {
  ACCOUNT,
  type AuthorizeRequest,
  authorizeRequest,
  SCOPES,
} from "@/lib/company/oauth";

export const dynamic = "force-dynamic";

const HINT: Record<string, string> = {
  "bookings:write": "Changes can cost money, and can't always be undone.",
};

export default async function Authorize({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const query = new URLSearchParams(
    Object.entries(raw).flatMap(([k, v]) =>
      typeof v === "string" ? [[k, v]] : [],
    ),
  );
  let checked: AuthorizeRequest | { redirect: string };
  try {
    checked = await authorizeRequest(query);
  } catch (err) {
    return (
      <main className="company">
        <div className="company-card">
          <div className="company-brand">Flight Sector</div>
          <p>
            This sign-in request can&apos;t be used:{" "}
            {err instanceof PoppyError ? err.message : "unknown error"}.
          </p>
        </div>
      </main>
    );
  }
  if ("redirect" in checked) redirect(checked.redirect);
  const { metadata, scopes } = checked;
  return (
    <main className="company">
      <form
        className="company-card"
        method="post"
        action="/oauth/authorize/decision"
      >
        <div className="company-brand">Flight Sector</div>
        <h1>{metadata.client_name} wants to use your Flight Sector account</h1>
        <p className="muted">
          Signed in as {ACCOUNT.name} ({ACCOUNT.email})
        </p>
        <input type="hidden" name="query" value={query.toString()} />
        <fieldset>
          <legend>Allow {metadata.client_name} to</legend>
          {scopes.map((scope) => (
            <label key={scope}>
              <input
                type="checkbox"
                name="scope"
                value={scope}
                defaultChecked
              />
              <span>
                {SCOPES[scope]}
                {HINT[scope] && <small>{HINT[scope]}</small>}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="company-actions">
          <button type="submit" name="decision" value="approve">
            Allow
          </button>
          <button
            type="submit"
            name="decision"
            value="decline"
            className="secondary"
          >
            Cancel
          </button>
        </div>
        <p className="muted small">
          {metadata.client_name} is <code>{metadata.client_id}</code>. You can
          disconnect it from your account settings at any time.
        </p>
      </form>
    </main>
  );
}
