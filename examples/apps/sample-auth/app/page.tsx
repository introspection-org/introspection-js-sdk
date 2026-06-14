import Link from "next/link";

/**
 * Landing page — one route per auth mode. The decision table mirrors the
 * "Choosing a mode" guide at https://docs.introspection.dev: who you are →
 * which mode. Each row links to a page that runs that flow end-to-end.
 */
const MODES: {
  href: string;
  who: string;
  name: string;
  hint: string;
}[] = [
  {
    href: "/jwks",
    who: "You have your own IdP / auth (Supabase, Auth0, any JWKS issuer)",
    name: "JWKS",
    hint: "jwks application — bring your own IdP, nothing to configure at your IdP",
  },
  {
    href: "/spa",
    who: "Introspection-hosted login (optionally brokering your own IdP)",
    name: "SPA",
    hint: "spa application — authorization_code + PKCE; brokered through a customers org if configured, else Introspection's hosted login",
  },
  {
    href: "/service-account",
    who: "You have no end users (server / CI)",
    name: "Service account",
    hint: "client_credentials with a server-side secret — machine token, no identity",
  },
];

export default function Home() {
  return (
    <main>
      <h1>Introspection sample auth</h1>
      <p className="subtitle">
        Three ways an application signs into Introspection — pick the row that
        matches who you are. Every mode converges on the same tail: an
        Introspection token, the <code>intro_dp_session</code> cookie, and a
        Data Plane session. See{" "}
        <a
          href="https://docs.introspection.dev"
          target="_blank"
          rel="noreferrer"
        >
          docs.introspection.dev
        </a>
        .
      </p>

      <div className="card">
        <div className="step">Choosing a mode</div>
        <div className="modes" style={{ flexDirection: "column" }}>
          {MODES.map((m) => (
            <Link
              key={m.href}
              href={m.href}
              className="mode-btn"
              style={{ textDecoration: "none" }}
            >
              <span className="mode-name">{m.name}</span>
              <span className="mode-hint">{m.who}</span>
              <span className="mode-hint">{m.hint}</span>
            </Link>
          ))}
        </div>
        <p className="field-help">
          The <code>jwks</code> application type is the simplest way to bring
          your own IdP — the partner IdP&apos;s own JWT is verified against its
          published JWKS; the IdP never knows Introspection exists.
        </p>
      </div>
    </main>
  );
}
