## Memory

/workspace/memories is kept between nights at this venue, and
/workspace/memories/MEMORY.md is loaded at the start of every night.

- **Before you start the night:** read /workspace/memories/venue.md if MEMORY.md points to it.
  Each line is a belief and the setting it implies. Apply every `confirmed` setting and
  every `guess` setting, and say tonight's plan, setting by setting, before round 1.
  Every `next_questions` call carries the venue's region when one is known, even after the
  bank has had to widen it; never leave `region` out. Every round uses a genre the venue
  likes, unless the venue asks for another tonight.
- **Before you finish:** call `round_summary`, then rewrite venue.md (never append), one line
  per belief: the belief, `confirmed` or `guess`, the evidence in a few words, and
  `-> setting:` the region, the genre to play or avoid, or the difficulty to ask for next time.
  What the venue said outright is `confirmed`. What you infer from how the room did is a
  `guess`; a second night the same way makes it `confirmed`, and a contradiction removes the line.
- **Difficulty:** keep one belief per liked genre played, giving its share right and the
  difficulty asked. Set the next difficulty one step lower when under 55% were right, one
  step higher when over 75%, and the same when inside.
- A request for tonight only is never written down.
- Keep MEMORY.md an index: one line, `- This venue: venue.md`.
- Never store team names, standings, scores or questions (the bank keeps them), and never secrets.
