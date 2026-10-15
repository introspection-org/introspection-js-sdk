import { highlight } from "@/components/code";
import { Rail } from "@/components/rail";
import { Sources, type RenderedSource } from "@/components/sources";
import { flow } from "@/flow/manifest.mjs";
import { recipe as recipeSource } from "@/flow/recipe.mjs";
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
          const { code, language, origin } = await readSource(root, source);
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
    <div className="shell">
      <Rail
        steps={steps.map((step) => ({
          id: step.id,
          title: step.title,
          platform: !step.lights,
        }))}
      />

      <main>
        <header className="hero">
          <p className="eyebrow">AAuth · Agent Provider · Person Server</p>
          <h1>{flow.title}</h1>
          <p>{flow.intro}</p>
          <p className="provenance">
            Recipe code is shown from{" "}
            <a href={`${recipeSource.repository}/tree/${recipeSource.ref}`}>
              recipe-travel-agent@{recipeSource.ref}
            </a>
            . Platform steps show the contract on the wire.
          </p>
        </header>

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
  );
}
