/**
 * The scorecard: each arm's metrics across every room, its worst room, and
 * whether it beats the control by more than the run-to-run spread. Metrics are
 * kept apart, never summed into one score.
 */
import { TARGET } from "../lib/host";
import { VENUES } from "../lib/venues";
import type { NightRecord } from "./rooms";

const mean = (values: number[]) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : NaN;
const pct = (value: number) =>
  Number.isNaN(value) ? "-" : `${Math.round(value * 100)}%`;
const pts = (value: number) =>
  Number.isNaN(value) ? "-" : (value * 100).toFixed(1);

/** The genre a round was in: the one most of its questions share. */
const genreOf = (genres: string[]) =>
  [...new Set(genres)].sort(
    (a, b) =>
      genres.filter((g) => g === b).length -
      genres.filter((g) => g === a).length,
  )[0];

interface NightMetrics {
  pitchMiss: number;
  blankRate: number;
  askedFor: number;
  finishGap: number;
  unfair: number;
  repeats: number;
  complete: boolean;
}

function nightMetrics(
  night: NightRecord,
  everAsked: Set<string>,
): NightMetrics {
  const venue = VENUES.find((item) => item.id === night.venue)!;
  const rates = night.rounds.map((round) =>
    round.answers ? round.correct / round.answers : 0,
  );
  let unfair = 0;
  let repeats = 0;
  for (const round of night.rounds) {
    for (const [index, id] of round.question_ids.entries()) {
      if (everAsked.has(id)) repeats += 1;
      everAsked.add(id);
      const region = round.regions[index];
      if (region !== "global" && region !== venue.region) unfair += 1;
    }
  }
  const answers = night.rounds.reduce((sum, round) => sum + round.answers, 0);
  const blanks = night.rounds.reduce((sum, round) => sum + round.blanks, 0);
  const questions = night.rounds.reduce(
    (sum, round) => sum + round.question_ids.length,
    0,
  );
  const [first, second] = night.standings;
  return {
    pitchMiss: mean(rates.map((rate) => Math.abs(rate - TARGET.aim))),
    blankRate: answers ? blanks / answers : NaN,
    askedFor: night.rounds.length
      ? night.rounds.filter((round) =>
          venue.likes.includes(genreOf(round.genres) as never),
        ).length / night.rounds.length
      : NaN,
    finishGap:
      first && second && questions
        ? (first.points - second.points) / questions
        : NaN,
    unfair,
    repeats,
    complete: !night.error && night.rounds.length === 3,
  };
}

/** Whether a tonight-only request reached the venue's notes. */
function leaked(nights: NightRecord[]): boolean {
  return nights.some(
    (night) =>
      night.venue === "quiz-and-quill" &&
      night.night >= 2 &&
      // A line that keeps music as liked, unless it says it was for one night.
      Object.values(night.memory).some((text) =>
        text
          .split("\n")
          .some(
            (line) =>
              /music/i.test(line) &&
              /lik|love|prefer|favou?rite/i.test(line) &&
              !/birthday|tonight|one night|just for|only for|not (a )?(liked|favou?rite)|dislike/i.test(
                line,
              ),
          ),
      ),
  );
}

const cost = (rows: NightRecord[]) => {
  const spent = rows
    .map((row) => row.cost_usd)
    .filter((value): value is number => value !== undefined);
  return spent.length ? `$${mean(spent).toFixed(3)}` : "-";
};

export function report(records: NightRecord[]): string {
  const arms = [...new Set(records.map((record) => record.arm))];
  const scored = new Map<NightRecord, NightMetrics>();
  const series = new Map<string, NightRecord[]>();
  for (const record of records) {
    const key = `${record.arm}|${record.venue}|${record.rep}`;
    series.set(key, [...(series.get(key) ?? []), record]);
  }
  for (const nights of series.values()) {
    const everAsked = new Set<string>();
    for (const night of [...nights].sort((a, b) => a.night - b.night))
      scored.set(night, nightMetrics(night, everAsked));
  }
  const of = (rows: NightRecord[], pick: (m: NightMetrics) => number) =>
    mean(
      rows
        .map((row) => pick(scored.get(row)!))
        .filter((value) => !Number.isNaN(value)),
    );
  // Night 1 is the same for every arm: no host knows the room yet.
  const learned = (rows: NightRecord[]) => rows.filter((row) => row.night >= 2);
  const spread = (arm: string) => {
    const reps = [
      ...new Set(records.filter((r) => r.arm === arm).map((r) => r.rep)),
    ];
    const byRep = reps.map((rep) =>
      of(
        learned(records.filter((r) => r.arm === arm && r.rep === rep)),
        (m) => m.pitchMiss,
      ),
    );
    return byRep.length > 1 ? Math.max(...byRep) - Math.min(...byRep) : NaN;
  };
  const control =
    arms.find((arm) => arm === "control" || arm === "none") ?? arms[0];
  const controlMiss = of(
    learned(records.filter((r) => r.arm === control)),
    (m) => m.pitchMiss,
  );
  const lines = [
    "| Arm | Pitch miss, nights 2+ (pts from 65%) | vs control | Run-to-run spread | Blank rate | Asked-for rounds | Finish gap | Worst room (pitch miss) | Unfair | Repeats | Tonight-only leak | Cost / night | Complete nights |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const arm of arms) {
    const rows = records.filter((record) => record.arm === arm);
    const later = learned(rows);
    const miss = of(later, (m) => m.pitchMiss);
    const venues = [...new Set(rows.map((row) => row.venue))];
    const worst = venues
      .map((venue) => ({
        venue,
        miss: of(
          later.filter((row) => row.venue === venue),
          (m) => m.pitchMiss,
        ),
      }))
      .sort((a, b) => b.miss - a.miss)[0];
    const armSpread = Math.max(spread(arm) || 0, spread(control) || 0);
    const gain = controlMiss - miss;
    const verdict =
      arm === control
        ? "control"
        : Number.isNaN(gain)
          ? "-"
          : `${gain >= 0 ? "-" : "+"}${pts(Math.abs(gain))} ${gain > armSpread ? "(beats)" : "(tie)"}`;
    const complete = rows.filter((row) => scored.get(row)!.complete).length;
    lines.push(
      `| ${arm} | ${pts(miss)} | ${verdict} | ${pts(armSpread)} | ${pct(of(rows, (m) => m.blankRate))} | ${pct(of(rows, (m) => m.askedFor))} | ${pct(of(rows, (m) => m.finishGap))} | ${worst ? `${worst.venue} ${pts(worst.miss)}` : "-"} | ${rows.reduce((s, r) => s + scored.get(r)!.unfair, 0)} | ${rows.reduce((s, r) => s + scored.get(r)!.repeats, 0)} | ${leaked(rows) ? "yes" : "no"} | ${cost(rows)} | ${complete}/${rows.length} |`,
    );
  }
  const nights = [...new Set(records.map((record) => record.night))].sort(
    (a, b) => a - b,
  );
  lines.push(
    "",
    "Pitch miss by night (pts from 65%):",
    "",
    `| Arm | ${nights.map((n) => `Night ${n}`).join(" | ")} |`,
    `| --- |${nights.map(() => " --- |").join("")}`,
  );
  for (const arm of arms)
    lines.push(
      `| ${arm} | ${nights
        .map((n) =>
          pts(
            of(
              records.filter((r) => r.arm === arm && r.night === n),
              (m) => m.pitchMiss,
            ),
          ),
        )
        .join(" | ")} |`,
    );
  const errors = records.filter((record) => record.error);
  if (errors.length) {
    lines.push("", "Errors:", "");
    for (const record of errors)
      lines.push(
        `- ${record.arm} ${record.venue} r${record.rep} night ${record.night}: ${record.error}`,
      );
  }
  return lines.join("\n");
}
