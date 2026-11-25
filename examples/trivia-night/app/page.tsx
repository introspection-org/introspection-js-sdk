import { PlatformEvals } from "@/components/platform-evals";

export default function Page() {
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
