# Preregistration: does what the host remembers help?

Frozen at commit: `<commit hash, filled in before the held-out run>`

## Hypothesis

A trivia host that keeps notes on a venue runs a better second night there, and it is better because of what the notes say, not because notes are there at all. Model notes (right notes: its own night 1's) beat no notes, and other notes (wrong notes: another pub's) do worst.

## World

Each pub is a simulated crowd of people (`recipe-operator/fakes/world/crowd.ts`): eight teams of three to six members, each member with an age and an interest in each genre. A member knows an answer with probability logistic(A + B·interest + C·cohort + D·(the venue's country or global ? 1 : −3) − E·difficulty), where cohort is how much of the question's decade the member lived through between the ages of about 10 and 35; a team answers right when any member knows it, times 0.9 for conferring. The same team answers the same question the same way on every night and in every arm. The pub's tastes are read off its crowd, never set: how much it enjoys a genre is its members' mean interest, its favourites are the top two, its disliked genre the lowest, its level the difficulty its default crowd of five answers 65% right on its favourites, and its best decades the two it answers best. Night 1's instruction names one favourite only; the other favourite, the genre the crowd dislikes, the right difficulty and the decades it knows best have to be learned from `round_summary`.

A night is six rounds of four questions, so a host can see a round land and adjust the next.

- **Development pubs** (11, `evals/venues.json`) are for building and checking the host and this analysis.
- **Held-out pubs** (20, `evals/heldout.json`, drawn by `evals/heldout.mjs` with a fixed seed) are used once, for the confirmatory run, after this file is frozen.

## Corpus construction

- **Demographics** (`fakes/world/demographics.ts`): per country (au, uk, us), weighted age bands and eight interest archetypes with weighted mixes. They are illustrative, loosely shaped on adult age pyramids and what quiz-goers follow, not census-accurate.
- **Crowds**: each pub tilts its country's mix by a scene drawn from the pub's id (some archetypes and ages more common there), then draws eight teams from it: a team is friends of about one age, most of one leaning. Every draw is seeded by the pub's id, so the corpus is the same on every machine.
- **Calibration**: the constants are set so a typical team at difficulty 3 answers about 70% of its favourite genre right and about 40% of its least favourite, and all-star teams are rare (`evals/crowd-report.mjs`).
- **Stereotype rule**: each city has a written list of the two genres a host would guess from its name (`fakes/world/stereotypes.ts`). A pub's crowd is redrawn while its two favourites overlap that list, up to 16 draws; if every draw overlaps, the first with the least overlap is kept. `evals/stereotype-check.mjs` reports the overlap before and after, held-out pubs as totals only.
- **Turnover**: night 2's crowd is about four in five of night 1's teams with new teams from the same pub's mix filling the rest: of five teams exactly four return; of three, two or three; of eight, six or seven, each chosen by a draw seeded by the pub. Every night-2 arm at a pub faces the same teams. Returning teams are reported as having played there before. The truth notes are graded against, and the true notes, come from night 1's crowd: what a host could have learned.

## Arms

Every pub plays night 1, then night 2 four ways. The same simulated teams answer every night 2, so only the host's choices differ.

| Arm                        | Night 2 runs as                                                                 | Notes it loads                     |
| -------------------------- | ------------------------------------------------------------------------------- | ---------------------------------- |
| Model notes (right notes)  | the customer whose night 1 it was                                               | its own night 1's                  |
| No notes                   | a new customer                                                                  | none                               |
| Other notes (wrong notes)  | the customer of another pub's night 1, in another country with other favourites | that pub's (a placebo)             |
| True notes (perfect notes) | a customer whose memory night 0 seeded                                          | the venue's true notes (a ceiling) |

Night 0 seeds the true notes: its instruction carries notes written from the venue's true tastes by `evals/venues.mjs` (`perfectNotes`), with no model writing them, and its verifier checks `memories/MEMORY.md` holds exactly those notes (`notes_seeded`). The memory then persists for that customer like any other. A true-notes night 2 whose night 0 failed `notes_seeded` is excluded.

An other-notes night 2 starts only after the donor pub's night 1 and model-notes night 2 have finished, so neither of the donor's reads sees its writes.

## Measures

Each is computed by the task's verifier from the bank's record of the crowd's answers, with no model.

- **Primary: good rounds.** The share of a night's rounds that are both in a genre the crowd loves and 55-75% right.
- **Secondary:** how close the finish was (the gap between the top two as a share of the points on offer); lead changes (times the lead changed hands after a round, divided by the five chances it had); the last-placed team's points as a share of the winner's; notes accuracy; right region (every question from the pub's country or global).
- **Descriptive:** rounds in a favourite genre; rounds 55-75% right; each round's share right by round number per arm; the return-visit judge's 1-5 score.
- **Notes accuracy** (night 1): the mean of four checks of night 1's notes against night 1's crowd: the favourite it was not told about named as liked, no disliked genre named as liked, the right country and no other, and a starting difficulty within one of the crowd's level. Whether the notes name the decade the crowd knows best is reported but not scored: best decades are mostly the 2000s or 2010s, so it barely tells pubs apart.
- **Notes stay crowd-level**: notes must name no team, from either night; the verifier's `notes_name_no_team` (night 1) and `notes_kept` (night 2) guards measure it as before.

## Analysis

Per pub, the paired difference between arms (`lib/experiment.ts`).

1. **World validity gate**, on development pubs before any held-out run: true notes minus no notes on good rounds must be at least 0.15, with its 95% t-interval excluding 0 (`validityGate`). If it fails, the world can't tell a weak host from a strong one, and the held-out run does not go ahead.
2. **Model vs no notes** on good rounds: mean paired difference with its 95% t-interval.
3. **Model vs other notes** on good rounds: exact two-sided sign test, ties dropped.
4. **Secondary measures**, model vs no notes: exact sign tests, Holm-corrected across the five (close finish, lead changes, last place's share, notes accuracy, right region).
5. **Ordering** on good rounds: true ≥ model > no notes > other, on the arm means (`ordering`), reported descriptively.

## Decision rule

On the 20 held-out pubs, with the development gate passed: memory is **supported** when the model-minus-no-notes interval on good rounds excludes 0 above, and model notes beat other notes by sign test with p < 0.05.

## What counts as failure

- The interval on model minus no notes includes 0 or lies below it: memory is not shown to help.
- Model notes do not beat other notes (p ≥ 0.05): any help is not shown to come from what was remembered.
- The gate fails on development pubs: no claim is made, and the world is changed before trying again.

Secondary measures and the ordering are reported whatever they show, and do not change the decision.

## Second hypothesis: a self-improved recipe

Starting from the original Recipe, whose memory block is empty, the Operator's `improve/memory` writes a memory block that makes second nights better, and the gain holds on pubs it never saw.

### The search (development pubs only)

The Operator runs its own procedure (`skills/improve-memory` in the release it runs from, recorded with the result), with these fixed inputs:

- **Series**: `experiment/night-series.eval.ts`, frozen: each candidate plays a development pub's night 1 and then night 2 from its own notes, in fresh sessions, under Vitest on the local Runtime, with the same fakes, instructions and crowd as the platform tasks. Night 2 is scored by that pub's own `check.mjs`.
- **Subjects**: the 11 development pubs for training; the held-out pubs are never given to it.
- **Fitness**: good rounds on night 2, reported per pub with its worst pub; rounds in a favourite genre, rounds 55-75% right and notes that name no team as separate metrics.
- **Edit surface**: only the text between `<!-- memory:start -->` and `<!-- memory:end -->`, from an empty block.
- **Model**: the Operator and the host on the Pi subscription; no API key in its environment.

### Confirmation (held-out pubs)

On the 20 held-out pubs, each recipe plays night 1 and then night 2 as the same customer:

- **Original**: the empty block.
- **Self-improved**: the block `improve/memory` picked, frozen with this file.
- **Hand-written**: the block the model-notes arm uses, for reference only.

**Primary**: self-improved minus original on good rounds, the mean paired difference and its 95% t-interval. **Supported** when the interval excludes 0 above. Self-improved minus hand-written, and the secondary measures, are reported whatever they show.

The Operator's own development score is not evidence: it was picked as the best of many, so it is optimistic by construction.
