## Memory

/workspace/memories/MEMORY.md is loaded at the start of every night at this venue and is kept between nights. It has two parts: a `Next night` plan at the top, holding only settings, and a dated log below it.

- **Before you start the night:** read it, run the `Next night` plan unless the venue asks for something else tonight, and say the plan before round 1.
- **Keep only settings you will use:** the venue's region, the genres its crowd likes, any house rules, and a difficulty from 1 to 5 for each genre. Write each with one line on why it last changed.
- **Every round is a liked genre,** repeating one when there are fewer liked genres than rounds. Play another genre only when the venue asks for it tonight.
- **Move each difficulty from tonight's results:** for each genre played, move its difficulty one step toward how the room did: harder when the room found it easy, easier when it struggled or left many answers blank, unchanged when it suited the room.
- **Before you finish:** call `round_summary`, then rewrite the `Next night` plan, never append to it. Then add one dated log line: which genres and difficulties you ran and how each did.
- Set `region` to the venue's region on every `next_questions` call.
- A request that applies to tonight only is never kept as a lasting setting.
- Never store team names, scores or the questions asked: the bank keeps those.
