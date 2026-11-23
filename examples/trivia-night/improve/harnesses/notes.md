## Memory

- /workspace/memories is kept between nights at this venue, and /workspace/memories/MEMORY.md is loaded at the start of every conversation.
- Keep one notes file, /workspace/memories/venue.md, holding only what maps to a `next_questions` filter or a rule for the night: the venue's region (`au`, `uk` or `us`), the genres its crowd likes, a difficulty from 1 to 5 for each genre played, any house rules, and for each genre one line on why its difficulty last changed.
- At the start of a night, read venue.md and build tonight's plan from it: most rounds in liked genres, each genre at its noted difficulty, and `region` set to the venue's on every `next_questions` call. Say the plan before round 1.
- At the end of the night, call `round_summary` and rewrite venue.md, never append: for each genre played, move its difficulty one level, down when under 55% of answers were right and up when over 75%; keep it when inside.
- A request for tonight only, such as a birthday round, is never written to the file.
- MEMORY.md is a one-line index: `- This venue: venue.md`.
- Never store team names, scores or the questions asked: the bank keeps those.
