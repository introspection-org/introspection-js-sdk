/**
 * The meta agent's view of a session run: for each parent harness, its memory
 * block, its metrics per subject (venue) and conversation (night), and where
 * each night's trajectory and memory folder are.
 *
 *   pnpm -s meta-input <run-dir> <arm> [<arm> ...] > parents.md
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { TARGET } from "../lib/host";
import { VENUES } from "../lib/venues";
import type { NightRecord } from "./rooms";

const [run, ...arms] = process.argv.slice(2);
const root = resolve(run);
const nights = readdirSync(join(root, "nights")).map(
  (name) =>
    JSON.parse(readFileSync(join(root, "nights", name), "utf8")) as NightRecord,
);
const block = (arm: string) => {
  const system = readFileSync(
    `.introspection-work/cand-${arm}/SYSTEM.md`,
    "utf8",
  );
  return (
    /<!-- memory:start -->\n([\s\S]*?)<!-- memory:end -->/.exec(system)?.[1] ??
    ""
  );
};
const pct = (value: number) => `${Math.round(value * 100)}%`;

const out = [
  "Metrics, per night: `pitch miss` is how far each round's share of right answers sat from 65% (lower is better; the target band is 55% to 75%); `liked` is the share of rounds in genres the venue likes; `foreign` counts questions local to another country (0 is right); `blanks` is the share of answers left empty.",
  "",
];
for (const arm of arms) {
  out.push(
    `### Parent \`${arm}\``,
    "",
    "Memory block:",
    "",
    "```markdown",
    block(arm).trim() || "(empty)",
    "```",
    "",
  );
  out.push(
    "| Subject | Night | Rounds (% right) | Pitch miss | Liked | Foreign | Blanks | Trajectory | Memory after |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  const mine = nights
    .filter((night) => night.arm === arm)
    .sort((a, b) => a.venue.localeCompare(b.venue) || a.night - b.night);
  for (const night of mine) {
    const venue = VENUES.find((item) => item.id === night.venue)!;
    const rates = night.rounds.map((round) =>
      round.answers ? round.correct / round.answers : 0,
    );
    const miss =
      rates.reduce((sum, rate) => sum + Math.abs(rate - TARGET.aim), 0) /
      Math.max(1, rates.length);
    const liked =
      night.rounds.filter((round) =>
        venue.likes.includes(round.genres[0] as never),
      ).length / Math.max(1, night.rounds.length);
    const foreign = night.rounds
      .flatMap((round) => round.regions)
      .filter(
        (region) => region !== "global" && region !== venue.region,
      ).length;
    const answers = night.rounds.reduce((sum, round) => sum + round.answers, 0);
    const blanks = night.rounds.reduce((sum, round) => sum + round.blanks, 0);
    const trajectory = join(
      root,
      "trajectories",
      `${night.user_id}-n${night.night}.jsonl`,
    );
    const memory = join(root, "memory", night.user_id, `night-${night.night}`);
    out.push(
      `| ${night.user_id} | ${night.night} | ${rates.map(pct).join(" / ")} | ${(miss * 100).toFixed(1)} | ${pct(liked)} | ${foreign} | ${pct(blanks / Math.max(1, answers))} | ${existsSync(trajectory) ? trajectory : "(none)"} | ${existsSync(memory) ? memory : "(empty)"} |`,
    );
  }
  out.push("");
}
console.log(out.join("\n"));
