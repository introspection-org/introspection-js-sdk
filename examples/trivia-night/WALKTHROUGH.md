# Walkthrough: from one prompt to a host that remembers each venue

This is the owner's script for replaying, from nothing, how this example's memory was built and improved. A fresh Operator session plays itself; you play the owner and answer from the script below. The session must never read this folder: work in an empty one, so everything it does comes from the Operator's skills and your answers.

## What you need

- The `introspection` CLI 0.95.0 or later (`npm i -g @introspection-ai/cli@latest`), which has `introspection eval simulate call|state`; the Recipe's fakes pull `@introspection-ai/eval-simulate` 0.10.0 or later on their own.
- The Operator 0.4.7 or later (`introspection upgrade`), with `improve-memory` and `eval-simulate`'s world reference.
- A Claude Code session on a subscription (unset `ANTHROPIC_API_KEY` so it doesn't use an API key), and a current Pi sign-in (`pi`, then `/login`) for the local case runs during build. No platform stack is needed until the last step, which runs on the cloud staging lane; never run a simulation against production or a local stack.

## 1. The prompt

> Build me a pub trivia host. It picks questions from a question bank, reads them out, scores the rounds, and should get better at each venue it hosts week after week.

## 2. Build

The Operator brainstorms and drafts. It asks in its own words, usually a few gap questions at once; answer from these:

| It asks                                  | You answer                                                                                                                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who uses it, and where?                  | Pub quiz hosts. Each venue has its own crowd, region and favourite genres.                                                                                                                                                              |
| What does a good night look like?        | Rounds land near two in three answers right; mostly genres the crowd likes; no questions only another country would know.                                                                                                               |
| What tools does it need?                 | A question bank: list questions by genre, region and difficulty; submit a round's answers; get a round summary.                                                                                                                         |
| What should it remember, and what never? | The venue owns its memory. Facts live in the bank, judgement in the notes. Keep only what changes the next night's choices. A request for tonight is never a lasting preference. Never store team names, scores or the questions asked. |
| How does it change difficulty?           | Adapt between rounds, never inside one; one level at a time; say the plan at the start of the night.                                                                                                                                    |

Expect: a brief and three or so draft cases to approve ("Approve all"), then a Recipe whose system prompt has its memory instructions between `<!-- memory:start -->` and `<!-- memory:end -->`, a fake of the question bank in `fakes/`, and local case runs. It also asks how to deploy; answer that it should improve memory first, in-session, before anything goes on the platform.

## 3. The world

Improve starts with one interview, usually with a suggested answer to each question; correct what differs from these, or volunteer a row it didn't ask:

| It asks                                                   | You answer                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| What differs between venues?                              | Region (AU, UK, US); how strong the crowd is in each of six genres; which genres it says it likes; how many teams.                  |
| What can the host observe?                                | Each round's share of right answers and blanks, and what the trivia master says when asked.                                         |
| What does the host do that the crowd rewards or punishes? | Difficulty against the crowd's strength in a genre sets how many get it right; another country's local questions are unfair.        |
| What does a venue say, and what only shows?               | It says its region and liked genres; its strength shows only in the results.                                                        |
| A one-night request?                                      | In one venue's second week, a birthday guest asks for one music round, for that night only.                                         |
| What can run out?                                         | The bank's questions: a venue is never asked the same one twice.                                                                    |
| The metrics?                                              | Pitch miss (points from 65% right, nights two onward), asked-for rounds, unfair questions, blanks, and the one-night-request guard. |

Expect it to read back, as code, a venue profile and a reaction: the chance a team is right rises with its genre strength and falls with difficulty, with a bonus for its own region. It should size the bank so no venue's series empties a cell, generating and checking extra questions if needed. It should sample eight held-out venues from a fixed seed. Before any candidate runs, every world check should pass, including "a host that pitches to the crowd beats one that doesn't".

Your checkpoints: approve the read-back, and confirm the budget once (a few hundred conversations, all in-session; a smaller run of three nights of three rounds is enough to see the shape).

## 4. Improve

From there it runs without asking. Expect:

- **Generation 0:** the shipped block as the control plus up to four seeds (free-form, dated log, beliefs with evidence, a notes file).
- **Generations 1 to 3:** the meta agent revises the best two or three, each revision reviewed against your rules before it runs, with a crossover from generation 2.
- **Held out:** the training ties run twice on the held-out venues, and the best is chosen there.

## 5. What a pass looks like

The numbers will differ run to run; the shape should not:

- Every searched block beats the shipped block held out by a wide margin (here about ten points of pitch miss: roughly 26 against 16).
- No candidate asks another country's questions, and none keeps the one-night request.
- Gaps between the best few blocks are within their standard error, and the scorecard calls them a tie rather than crowning a leader.
- The chosen block reads as settings for the next night (a region, liked genres, a level per genre), not a diary.

Then you choose one from the scorecard, and it opens the Recipe's pull request with the held-out result. Confirming it on the staging lane comes after.

## Reference

This example's own run, for comparing what you get: `improve/` holds the seeds and the meta agent's revisions, `improve/bank` the generated and checked questions, and `lib/venues.ts` the venue model and the sampled held-out venues.
