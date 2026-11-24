import { PlatformEvals } from "@/components/platform-evals";

export default function Page() {
  return (
    <main className="page">
      <header>
        <h1>Trivia Night</h1>
        <p>
          A quiz host that should remember each venue. These are the real memory
          evals, run as cloud trials of the deployed host: night 1 leaves the
          venue&apos;s notes, and night 2 has to use them.
        </p>
      </header>
      <PlatformEvals />
    </main>
  );
}
