import type { Metadata } from "next";

import "./acme.css";

export const metadata: Metadata = {
  title: "Acme · Travel approvals",
  description: "Approve or decline travel outside Acme's policy.",
};

export default function AcmeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="acme">
      <header className="acme-bar">
        <span className="acme-mark">A</span>
        <span>Acme</span>
        <span className="acme-bar-sub">Travel approvals</span>
      </header>
      <main className="acme-main">{children}</main>
    </div>
  );
}
