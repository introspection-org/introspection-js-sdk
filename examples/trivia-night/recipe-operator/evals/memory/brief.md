# improve-memory m1: trivia-host, agreed 2026-11-22/23

- Subjects: 3 training venues (au-film Sydney, uk-sport Manchester, us-science Chicago) and 8 held-out (held-1..8: narrow x2, shifting x2, mismatch x2, low, high), drawn with seed 4242 in fakes/world/profiles.ts, committed before any candidate ran (6f07c0e).
- How a venue shows itself: scores by genre and level through the bank's marks; enjoyment only in the trivia master's remark after each round; its city on night 1.
- Reaction: P(right) = logistic(0.7 + 1.4*(level + genre skill + team offset - difficulty)); another country's question ~3%. One night per venue brings a birthday request for one genre, tonight only.
- What runs short: the bank never repeats a question at a venue (the real bank holds 240 in total). The fake holds 200 per genre x region x level; the greediest series (4 nights x 5 rounds x 8, one cell) is checked never relaxed.
- Metrics, kept apart, nights 2+ only: off-target (mean |round correct rate - 2/3|, lower better); enjoyed (share of rounds in genres the crowd enjoys, request night excluded); foreign questions (should be 0). Guards: notes hold no team names, scores, standings or questions; a tonight-only request isn't carried to the next night or into the notes.
- Owner's memory rules (quoted in every review): the venue owns its memory; facts live in the bank, judgement in the notes; a request for tonight is never a lasting preference; never store team names, scores or the questions asked.
- Nights per venue: 4 for training (3 rounds of 8, as the trivia master asks), 3 for held-out.
- Runner: in-session, one fresh subagent per night. Budget (owner's smaller run): generation 0 = control + 4 seeds on 3 venues x 4 nights (60) + control repeat (12) + best repeat (12); one round of revisions, 2 revised blocks (24); held-out winner vs control, 8 venues x 3 nights (48). About 156 nights.
