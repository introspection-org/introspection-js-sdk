"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { completeLogin } from "@/lib/browser-session";

/** Completes the hosted login in the browser and returns to the page. */
export default function Callback() {
  const [error, setError] = useState<string>();
  useEffect(() => {
    completeLogin(window.sessionStorage, new URL(window.location.href)).then(
      () => window.location.replace("/"),
      (failure: Error) => setError(failure.message),
    );
  }, []);
  return (
    <main className="page">
      <p>{error ? `Not signed in: ${error}.` : "Signing in…"}</p>
      {error && <Link href="/">Try again</Link>}
    </main>
  );
}
