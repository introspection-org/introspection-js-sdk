import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Trivia Night",
  description:
    "A quiz host that never repeats a question at a venue and pitches each round to its crowd.",
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
