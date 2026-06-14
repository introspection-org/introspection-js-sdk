import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Introspection — B2B2C Auth Modes Sample",
  description:
    "One route per auth mode: direct JWKS (canonical SPA), Zitadel-brokered, Introspection-hosted login, and service-account machine tokens.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
