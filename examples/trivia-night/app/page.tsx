import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { PlatformEvals } from "@/components/platform-evals";
import { SESSION_COOKIE, sessionFor } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Page() {
  if (!sessionFor((await cookies()).get(SESSION_COOKIE)?.value))
    redirect("/login");
  return (
    <main className="page">
      <header>
        <h1>Trivia Night</h1>
        <p>
          A quiz host that remembers each pub: night 1 leaves notes, night 2
          uses them.
        </p>
      </header>
      <PlatformEvals />
    </main>
  );
}
