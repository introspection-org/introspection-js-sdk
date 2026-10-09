import recipeSource from "@/recipe/SOURCE.json";

import { highlight } from "@/components/code";
import { EventFeed, LiveProvider, StepDot } from "@/components/live";
import { Sources, type RenderedSource } from "@/components/sources";
import { flow } from "@/flow/manifest.mjs";
import { readSource } from "@/lib/source.mjs";

export const dynamic = "force-dynamic";

const KIND_NOTE = {
  example: "Flight Sector's code in this example",
  recipe: "the public recipe",
  contract: "a platform contract: the shape on the wire, not the code",
};

export default async function Page() {
  const root = process.cwd();
  const steps = await Promise.all(
    flow.steps.map(async (step) => ({
      ...step,
      rendered: await Promise.all(
        step.sources.map(async (source): Promise<RenderedSource> => {
          const { code, language, origin } = readSource(root, source);
          return {
            label: source.label ?? source.path,
            origin,
            kind: source.kind,
            language,
            html: await highlight(code, language),
          };
        }),
      ),
    })),
  );

  return (
    <LiveProvider steps={flow.steps.map(({ id, lights }) => ({ id, lights }))}>
      <div className="shell">
        <nav className="rail">
          <div className="brand">Flight Sector</div>
          <ol>
            {steps.map((step, index) => (
              <li key={step.id}>
                <a href={`#${step.id}`}>
                  <StepDot id={step.id} live={Boolean(step.lights)} />
                  <span className="rail-index">{index + 1}</span>
                  {step.title}
                </a>
              </li>
            ))}
          </ol>
          <div className="legend">
            <span>
              <span className="dot dot-lit" /> seen in this run
            </span>
            <span>
              <span className="dot dot-platform" /> inside the platform
            </span>
          </div>
        </nav>

        <main>
          <header className="hero">
            <p className="eyebrow">AAuth · Agent Provider · Person Server</p>
            <h1>{flow.title}</h1>
            <p>{flow.intro}</p>
            <p className="provenance">
              Recipe code is shown from{" "}
              <a
                href={`${recipeSource.repository}/tree/${recipeSource.commit}`}
              >
                recipe-travel-agent@{recipeSource.commit.slice(0, 7)}
              </a>
              . Platform steps show the contract on the wire.
            </p>
          </header>

          <section className="live">
            <h2>This run</h2>
            <EventFeed />
          </section>

          {steps.map((step, index) => (
            <section key={step.id} id={step.id} className="step">
              <div className="step-text">
                <p className="step-actor">
                  <span className="step-index">{index + 1}</span>
                  {step.actor}
                </p>
                <h2>{step.title}</h2>
                <p>{step.body}</p>
                <ul className="kinds">
                  {[...new Set(step.sources.map((s) => s.kind))].map((kind) => (
                    <li key={kind} className={`kind kind-${kind}`}>
                      {KIND_NOTE[kind]}
                    </li>
                  ))}
                </ul>
              </div>
              <Sources sources={step.rendered} />
            </section>
          ))}
        </main>
      </div>
    </LiveProvider>
  );
}
