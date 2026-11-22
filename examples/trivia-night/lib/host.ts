/**
 * Two stand-ins for the quiz host, so the bank and the scoring can be proved
 * before an agent is involved. Neither is the agent.
 *
 * `forgetful` plans every night the same way. `attentive` keeps notes on each
 * venue, in the shape an agent's memory file would take, and reads them back
 * before planning. The attentive host is the reference answer: if it cannot
 * beat the forgetful one on the scoring, the scoring is wrong.
 */
import type { Summary } from "./bank";
import type { Recorder } from "./events";
import { GENRES, type Genre, type Region } from "./questions";

export const ROUNDS = 3;
export const QUESTIONS_PER_ROUND = 3;
/** A round is pitched right when about this share of answers is correct. */
export const TARGET = { low: 0.55, aim: 0.65, high: 0.75 };

export interface RoundPlan {
  genre: Genre;
  difficulty: number;
  region?: Region;
}

export interface Notes {
  region?: Region;
  likes: Genre[];
  /** The difficulty that suits this crowd, per genre. */
  difficulty: Partial<Record<Genre, number>>;
  nights: number;
}

export interface Host {
  name: "forgetful" | "attentive";
  plan(
    owner: string,
    week: number,
    told: Told,
    recorder?: Recorder,
  ): RoundPlan[];
  after(owner: string, summary: Summary, recorder?: Recorder): void;
}

/** What a venue says about itself on its first night. */
export interface Told {
  region: Region;
  likes: Genre[];
}

const store = globalThis as unknown as { __triviaNotes?: Map<string, Notes> };
const memory = (store.__triviaNotes ??= new Map());

export function resetNotes(owner?: string): void {
  if (owner) memory.delete(owner);
  else memory.clear();
}

/** The notes as the file an agent would keep under /workspace/memories. */
export function notesFile(owner: string): string | undefined {
  const notes = memory.get(owner);
  if (!notes) return undefined;
  const pitch = GENRES.filter((genre) => notes.difficulty[genre])
    .map((genre) => `- ${genre}: difficulty ${notes.difficulty[genre]}`)
    .join("\n");
  return [
    "# This venue",
    "",
    `- Region: ${notes.region ?? "unknown"}`,
    `- The crowd likes: ${notes.likes.join(", ") || "unknown"}`,
    `- Nights hosted: ${notes.nights}`,
    "",
    "## Pitch",
    "",
    pitch || "- nothing learned yet",
    "",
  ].join("\n");
}

export const forgetful: Host = {
  name: "forgetful",
  plan(_owner, week) {
    return Array.from({ length: ROUNDS }, (_, round) => ({
      genre: GENRES[(week * ROUNDS + round) % GENRES.length],
      difficulty: 3,
    }));
  },
  after() {},
};

export const attentive: Host = {
  name: "attentive",
  plan(owner, _week, told, recorder) {
    let notes = memory.get(owner);
    recorder?.(
      owner,
      "memory.read",
      notes
        ? `Read this venue's notes (${notes.nights} night${notes.nights === 1 ? "" : "s"} hosted)`
        : "No notes for this venue yet",
      { file: notesFile(owner) ?? null },
    );
    if (!notes) {
      notes = {
        region: told.region,
        likes: told.likes,
        difficulty: {},
        nights: 0,
      };
      memory.set(owner, notes);
      recorder?.(
        owner,
        "memory.written",
        "Noted what the venue said about itself",
        {
          file: notesFile(owner),
        },
      );
    }
    const current = notes;
    // Most of the night is what the crowd asked for; one round keeps it varied.
    const others = GENRES.filter((genre) => !current.likes.includes(genre));
    const genres = Array.from({ length: ROUNDS }, (_, round) =>
      round < ROUNDS - 1 && current.likes.length
        ? current.likes[(round + current.nights) % current.likes.length]
        : others[current.nights % others.length],
    );
    const plan = genres.map((genre) => ({
      genre,
      difficulty: current.difficulty[genre] ?? 3,
      region: current.region,
    }));
    recorder?.(
      owner,
      "host.planned",
      "Planned tonight: " +
        plan.map((round) => `${round.genre} at ${round.difficulty}`).join(", "),
      { plan },
    );
    return plan;
  },
  after(owner, summary, recorder) {
    const notes = memory.get(owner);
    if (!notes) return;
    notes.nights += 1;
    const changes: string[] = [];
    for (const [genre, tally] of Object.entries(summary.by_genre)) {
      const was = notes.difficulty[genre as Genre] ?? 3;
      // One step when a round missed the band, two when it missed badly.
      const miss = tally.rate - TARGET.aim;
      const step =
        tally.rate > TARGET.high || tally.rate < TARGET.low
          ? Math.sign(miss) * (Math.abs(miss) > 0.25 ? 2 : 1)
          : 0;
      const now = Math.min(5, Math.max(1, was + step));
      notes.difficulty[genre as Genre] = now;
      if (now !== was)
        changes.push(
          `${genre} ${was} to ${now} (${Math.round(tally.rate * 100)}% right)`,
        );
    }
    recorder?.(
      owner,
      "memory.written",
      changes.length
        ? `Updated the pitch: ${changes.join("; ")}`
        : "Pitch unchanged: every round landed in the target band",
      { file: notesFile(owner) },
    );
  },
};
