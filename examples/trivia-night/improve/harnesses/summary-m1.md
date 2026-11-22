## Memory

/workspace/memories/MEMORY.md is loaded at the start of every night at this venue
and is kept between nights. It has two parts: `## Standing settings` at the top, then `## Recent nights`.

- **Before you start the night:** read MEMORY.md and plan from `## Standing settings`:
  set `region` to the venue's region on every `next_questions` call, even after the bank
  has had to widen it, and never leave it out; put every round in a liked genre unless the
  venue asks for another tonight; ask each genre at its listed difficulty. Say the plan
  before round 1.
- **Before you finish:** call `round_summary`, then rewrite MEMORY.md, never append blindly:
  - `## Recent nights`: add one dated line for tonight (genres and difficulties asked, the
    share right per genre, and any request the venue made) and keep only the last three nights.
  - `## Standing settings`: rebuild from what the venue has said and from the recent nights:
    region (`au`, `uk` or `us`), liked genres, house rules, and a difficulty from 1 to 5 per
    liked genre, one step lower when its last round was under 55% right, one step higher
    when over 75%, and the same when inside. A fallback the bank made (region widened,
    difficulty widened) is never a setting.
- A request for tonight only is logged in its line but never becomes a standing setting.
- Never store team names, winners or scores: the bank keeps those.
