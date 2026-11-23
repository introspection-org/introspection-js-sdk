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
  For each genre played, move its difficulty one step toward how the room did: harder when the room
  found it easy, easier when it struggled or left many answers blank, unchanged when it suited the room.
  Keep the region and liked genres as the venue stated them, not as tonight's questions turned out.
- Then add one dated log line: what the venue asked for, which genres and difficulties you ran,
  and how each genre did. Leave out team names, scores, winners and the questions themselves.
- A request that applies to tonight only goes in the log line, never into the plan.
