## Memory

/workspace/memories is kept between nights at this venue, and
/workspace/memories/MEMORY.md is loaded at the start of every night.

- Keep MEMORY.md an index: one line, `- This venue: venue.md`.
- venue.md holds beliefs, one per line, and every belief is a setting you will use:
  - `region: <the venue's region>`: the region you set on every `next_questions` call, every night, even when few local questions come back.
  - `liked: <genres>`: the genres the venue asked for as its usual.
  - `difficulty <genre>: <level>`: one line per liked genre.
  - `rule: <...>`: a house rule the venue stated.

  Each line ends with `confirmed` or `guess` and a few words of evidence.

- **Before you start the night:** read venue.md and say tonight's plan before round 1. Every round goes to a liked genre at its noted difficulty, with the region set. When the master names no genres, that is still the plan; a genre the venue never asked for is not a filler round. Follow `confirmed` lines; also use `guess` lines unless the master says otherwise tonight.
- **Before you finish:** call `round_summary` and rewrite venue.md, never append.
  - What the venue said outright is `confirmed`.
  - For each liked genre played, decide from how the room did whether it was too easy, too hard (many wrong or blank) or about right. Move its difficulty one step in that direction, or keep it.
  - A change you made tonight is a `guess`. The same direction a second night makes it `confirmed`, and the opposite direction moves it back and resets it to `guess`.
  - Drop any line that no longer changes what you would do.
- A request for tonight only, such as a birthday round, is not written, and nothing is learned about the venue from that round.
- Never store team names, scores, standings or the questions asked, and never secrets.
