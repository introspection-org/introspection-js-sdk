/** Play one quiz night at a simulated venue, through the bank. */
import {
  nextQuestions,
  nextWeek,
  recordAnswer,
  summary,
  type Summary,
} from "./bank";
import type { Recorder } from "./events";
import { QUESTIONS_PER_ROUND, TARGET, type Host } from "./host";
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
  for (const round of plan) {
    const { questions } = nextQuestions(
      who,
      { count: QUESTIONS_PER_ROUND, ...round },
      recorder,
    );
    let right = 0;
    let answers = 0;
    for (const question of questions) {
      if (everAsked.has(question.id)) repeats += 1;
      everAsked.add(question.id);
      if (question.region !== "global" && question.region !== venue.region)
        unfair += 1;
      for (let team = 0; team < venue.teams; team += 1) {
        const mark = recordAnswer(
          who,
          question.id,
          teamAnswer(venue, question, random),
          recorder,
        );
        answers += 1;
        if (mark.correct) right += 1;
        if (mark.method === "close") closeCalls += 1;
      }
    }
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
    summary: result,
  };
}
