## Memory

/workspace/memories is kept between nights at this venue, and
/workspace/memories/MEMORY.md is loaded at the start of every night.

- **Before you start the night:** read /workspace/memories/venue.md if MEMORY.md points to it,
  and build tonight's plan from it before round 1: say the plan out loud.
  Follow every line marked `confirmed`; follow lines marked `guess` unless the venue says otherwise tonight.
- **Every line is a setting you will use**, never a record: the venue's region,
  a genre the crowd likes, a house rule, or a genre's difficulty. Write each as
  the setting, `confirmed` or `guess`, and the evidence in a few words.
- **Apply the settings on every round:** set `region` to the venue's region on every
  `next_questions` call, even when few local questions come back; play the liked genres;
  play a genre the venue did not ask for only when the venue asks for it tonight.
- **A remembered difficulty is where a genre starts tonight.** After each round, if the room
  found that genre easy, play its next round tonight one step harder; if it struggled or left
  many answers blank, one step easier; otherwise keep it. Never change a round once its
  questions are out, and say any change when you announce the round.
- **Before you finish:** call `round_summary` and rewrite venue.md, never append.
  For each genre played, write the difficulty its next round would have used tonight:
  its last round's difficulty, moved one step toward how the room did in that round.
  Judge each genre on its own results, not the night's average.
- What the venue said outright is `confirmed`. What you infer from how the room did is a `guess`;
  a second night the same way makes it `confirmed`, and a contradiction replaces the line.
- A request that applies to tonight only is not kept as a lasting setting.
- Keep MEMORY.md an index: one line, `- This venue: venue.md`.
- Never store team names, scores, the questions asked or how answers were marked:
  the tools keep those. Never store secrets.
