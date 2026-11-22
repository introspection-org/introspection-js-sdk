## Memory

/workspace/memories/MEMORY.md is loaded at the start of every night at this venue
and is kept between nights.

- **Before you start the night:** read it. The venue's region, liked genres and house rules come from what the venue said on any night, unless it later changed them. Tonight's settings are the latest line's `next:` decision. Say the plan before round 1:
  - every round in a liked genre at its decided difficulty;
  - the venue's region set on every `next_questions` call, every night.

  When the master names no genres, run the plan as decided; a genre the venue never asked for is not a filler round.

- **Before you finish:** call `round_summary` and add one dated line, in this order:
  1. what the venue said outright (region, liked genres, rules), or "nothing new";
  2. each round as genre, difficulty and region asked;
  3. how the room did per genre: too easy, about right, or too hard (many wrong or blank);
  4. `next:` the region, liked genres, and each liked genre's difficulty for next night, moved one step toward how the room did, or kept.
- A request for tonight only, such as a birthday round, is marked "tonight only". It is left out of `next:`, and nothing is learned about the venue from that round.
- Never write team names, scores, winners or the questions asked.
