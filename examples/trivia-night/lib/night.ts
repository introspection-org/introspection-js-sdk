/** Play one quiz night at a simulated venue, through the bank. */
import { nextQuestions, nextWeek, summary, type Summary } from "./bank";
import type { Recorder } from "./events";
import { QUESTIONS_PER_ROUND, TARGET, type Host } from "./host";
import { registerTeams, submitRound, type TeamAnswer } from "./scorer";
import { seeded, teamAnswer, type Venue } from "./venues";

export interface NightResult {
  venue: string;
  host: Host["name"];
  week: number;
  rate: number;
  /** Rounds whose share of right answers fell inside the target band. */
  rounds_on_target: number;
  rounds: number;
  /** How far a round's share of right answers sat from the aim, on average. */
  pitch_miss: number;
  /** Rounds in a genre the venue said it likes. */
  liked_rounds: number;
  /** Questions local to somewhere else. */
  unfair_questions: number;
  /** Questions this venue had been asked before; the bank keeps this at 0. */
  repeats: number;
  close_calls: number;
  /** Answer sheets left empty. */
  blanks: number;
  summary: Summary;
}

export function owner(venue: Venue, host: Host): string {
  return `${host.name}:${venue.id}`;
}

export function playNight(
  venue: Venue,
  host: Host,
  seed: number,
  everAsked: Set<string>,
  recorder?: Recorder,
): NightResult {
  const who = owner(venue, host);
  const week = nextWeek(who);
  const random = seeded(seed + week * 7919);
  const teams = Array.from(
    { length: venue.teams },
    (_, index) => `Team ${String.fromCharCode(65 + index)}`,
  );
  registerTeams(who, teams);
  const plan = host.plan(
    who,
    week,
    { region: venue.region, likes: venue.likes },
    recorder,
  );
  let onTarget = 0;
  let miss = 0;
  let liked = 0;
  let unfair = 0;
  let repeats = 0;
  let closeCalls = 0;
  let blanks = 0;
  for (const round of plan) {
    const { questions } = nextQuestions(
      who,
      { count: QUESTIONS_PER_ROUND, ...round },
      recorder,
    );
    const sheet: TeamAnswer[] = [];
    for (const question of questions) {
      if (everAsked.has(question.id)) repeats += 1;
      everAsked.add(question.id);
      if (question.region !== "global" && question.region !== venue.region)
        unfair += 1;
      for (const team of teams)
        sheet.push({
          question_id: question.id,
          team,
          answer: teamAnswer(venue, question, random),
        });
    }
    const marks = sheet.length
      ? submitRound(who, sheet, recorder).questions.flatMap(
          (entry) => entry.marks,
        )
      : [];
    const answers = marks.length;
    const right = marks.filter((mark) => mark.correct).length;
    closeCalls += marks.filter((mark) => mark.method === "close").length;
    blanks += marks.filter((mark) => mark.method === "blank").length;
    const rate = answers ? right / answers : 0;
    if (rate >= TARGET.low && rate <= TARGET.high) onTarget += 1;
    miss += Math.abs(rate - TARGET.aim);
    if (venue.likes.includes(round.genre)) liked += 1;
  }
  const result = summary(who, week);
  host.after(who, result, recorder);
  recorder?.(
    who,
    "round.finished",
    `Week ${week}: ${Math.round(result.overall.rate * 100)}% right, ` +
      `${onTarget} of ${plan.length} rounds pitched right`,
    { week, rate: result.overall.rate },
  );
  return {
    venue: venue.id,
    host: host.name,
    week,
    rate: result.overall.rate,
    rounds_on_target: onTarget,
    rounds: plan.length,
    pitch_miss: plan.length ? miss / plan.length : 0,
    liked_rounds: liked,
    unfair_questions: unfair,
    repeats,
    close_calls: closeCalls,
    blanks,
    summary: result,
  };
}
