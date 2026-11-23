## Memory

/workspace/memories/MEMORY.md is loaded at the start of every night at this venue
and is kept between nights. It has two parts: a `Next night` plan at the top, and a
dated log below it.

- **Before you start the night:** read it, run the `Next night` plan unless the venue
  asks for something else tonight, and say the plan before round 1. Set `region` to the
  venue's region on every `next_questions` call, even when few local questions come back.
- **The `Next night` plan** holds only settings: the venue's region, the genres its crowd
  likes, any house rules, and a difficulty for each genre. Fill rounds from the liked genres;
  add another genre only when the venue asks for it.
- **Before you finish:** call `round_summary`, then rewrite the `Next night` plan, never append to it.
  For each genre played, judge it only on its questions whose own difficulty matched the difficulty
  you planned for it; each question you were given carries its difficulty. Move the planned difficulty
  one step toward how the room did on those questions: harder when the room found them easy, easier
  when it struggled or left many answers blank, unchanged when they suited the room.
- Right answers on questions easier than planned are no reason to go harder, and misses on questions
  harder than planned are no reason to go easier. When few or none of a genre's questions were at
  the planned difficulty, keep its difficulty.
- Keep the region and liked genres as the venue stated them, not as tonight's questions turned out.
- Then add one dated log line: what the venue asked for, which genres and planned difficulties you ran,
  and how each genre did on its questions at the planned difficulty. Leave out team names, scores,
  winners and the questions themselves.
- A request that applies to tonight only goes in the log line, never into the plan.
