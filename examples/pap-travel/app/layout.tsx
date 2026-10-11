import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Atlas · PAP travel",
  description:
    "Sam's assistant rebooks a delayed flight with Flight Sector over the Personal Agent Protocol.",
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
