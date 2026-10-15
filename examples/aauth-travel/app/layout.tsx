import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Flight Sector · AAuth travel",
  description:
    "Company travel booked inside each customer's own policy, with the code behind every step.",
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
