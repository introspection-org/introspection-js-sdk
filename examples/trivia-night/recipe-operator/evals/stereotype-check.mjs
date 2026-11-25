// Compares each platform-eval venue's two favourite genres, read off its crowd, with the genres
// its city's stereotype suggests (fakes/world/stereotypes.ts), before and after the reseed rule:
// a venue's crowd is redrawn while its top two overlap the stereotype, at most MAX_DRAWS draws,
// keeping the first with the least overlap. Development venues are listed one by one; held-out
// venues only as totals, so none of their tastes is shown. No model is called.
// Run `node recipe-operator/evals/stereotype-check.mjs`.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (file) =>
  import(pathToFileURL(path.join(here, "../fakes/world", file)).href);

/** Per venue: its stereotype, and how many of its top two match it on the first draw and on the kept one. */
export async function stereotypeCheck(profiles) {
  const { STEREOTYPES } = await load("stereotypes.ts");
  const { firstDrawOverlap } = await load("profiles.ts");
  const { ranked } = await load("crowd.ts");
  return profiles.map((p) => {
    const stereotype = STEREOTYPES[p.city] ?? [];
    const top = ranked(p.enjoy).slice(0, 2);
    return {
      city: p.city,
      stereotype,
      top,
      draw: p.draw ?? 0,
      before: firstDrawOverlap(p),
      after: top.filter((g) => stereotype.includes(g)).length,
    };
  });
}

const totals = (rows) => ({
  venues: rows.length,
  overlapping_before: rows.filter((r) => r.before > 0).length,
  overlapping_after: rows.filter((r) => r.after > 0).length,
  genres_matched_before: rows.reduce((s, r) => s + r.before, 0),
  genres_matched_after: rows.reduce((s, r) => s + r.after, 0),
});

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { PAGE, HELDOUT } = await load("profiles.ts");
  const dev = await stereotypeCheck(PAGE);
  for (const r of dev)
    console.log(
      `${r.city.padEnd(11)} stereotype ${r.stereotype.join("+").padEnd(17)} top two ${r.top.join("+").padEnd(17)} overlap ${r.before} -> ${r.after} (draw ${r.draw})`,
    );
  console.log("development", JSON.stringify(totals(dev)));
  console.log(
    "held-out   ",
    JSON.stringify(totals(await stereotypeCheck(HELDOUT))),
  );
}
