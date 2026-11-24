// Reports the crowd model's calibration over every platform-eval venue's regulars (development
// and held-out, pooled, so no held-out venue's outcome is shown): a team's expected share right
// at difficulty 3 on its favourite and least favourite genre, and the spread of team strengths.
// Run `node recipe-operator/evals/crowd-report.mjs`.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (file) =>
  import(pathToFileURL(path.join(here, "../fakes/world", file)).href);

/** The calibration numbers and the team-strength distribution, pooled over `profiles`. */
export async function crowdReport(profiles) {
  const { GENRES, expected, ranked, strength, teamInterest } =
    await load("crowd.ts");
  const { teamOf } = await load("profiles.ts");
  const teams = profiles.flatMap((p) =>
    p.teams.map((name) => ({ team: teamOf(p, name), region: p.region })),
  );
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const quantile = (xs, q) =>
    [...xs].sort((a, b) => a - b)[Math.round(q * (xs.length - 1))];
  const r2 = (x) => Math.round(x * 100) / 100;
  const favourite = [];
  const least = [];
  const strengths = [];
  for (const { team, region } of teams) {
    const order = ranked(teamInterest(team));
    favourite.push(expected([team], [order[0]], 3, region));
    least.push(expected([team], [order.at(-1)], 3, region));
    strengths.push(strength(team, region));
  }
  void GENRES;
  return {
    teams: teams.length,
    in_interest: {
      mean: r2(mean(favourite)),
      median: r2(quantile(favourite, 0.5)),
    },
    out_of_interest: {
      mean: r2(mean(least)),
      median: r2(quantile(least, 0.5)),
    },
    strength: Object.fromEntries(
      [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => [
        `p${q * 100}`,
        r2(quantile(strengths, q)),
      ]),
    ),
    all_star_share: r2(
      strengths.filter((s) => s >= 0.7).length / strengths.length,
    ),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { PAGE, HELDOUT } = await load("profiles.ts");
  console.log(
    JSON.stringify(await crowdReport([...PAGE, ...HELDOUT]), null, 2),
  );
}
