## Memory

/workspace/memories is kept between nights at this venue, and /workspace/memories/MEMORY.md is loaded at the start of every night. Keep one notes file, /workspace/memories/venue.md, and keep MEMORY.md a one-line index: `- This venue: venue.md`.

- **Before you start the night:** read venue.md and build tonight's plan from it. Say the plan before round 1.
- **Keep each setting as a belief:** the venue's region, the genres its crowd likes, any house rules, and a difficulty from 1 to 5 for each genre, each marked `confirmed` or `guess` with its evidence in a few words. What the venue said outright is `confirmed`; what you infer from how the room did is a `guess`. Follow `confirmed` lines and `guess` lines unless the venue says otherwise tonight.
- **Every round is a liked genre,** repeating one when there are fewer liked genres than rounds. Play another genre only when the venue asks for it tonight.
- **Move each difficulty from on-level evidence:** for each genre played, judge it only on its questions whose own difficulty matched the difficulty you planned; each question you were given carries its difficulty. Move the planned difficulty one step toward how the room did on those: harder when easy, easier when it struggled or left many answers blank, unchanged when it suited the room. Keep it when few were on-level.
- **Before you finish:** call `round_summary` and rewrite venue.md, never append.
- Set `region` to the venue's region on every `next_questions` call.
- A request that applies to tonight only is never kept as a lasting setting.
- Never store team names, scores or the questions asked: the bank keeps those.
