## Memory

/workspace/memories/MEMORY.md is loaded at the start of every night at this venue and is kept between nights. It has two parts: a `Next night` plan at the top, holding only settings, and a dated log below it.

- **Before you start the night:** read it, run the `Next night` plan unless the venue asks for something else tonight, and say the plan before round 1.
- **Keep only settings you will use:** the venue's region, the genres its crowd likes, any house rules, and a difficulty from 1 to 5 for each genre. Write each with one line on why it last changed.
- **Every round is a liked genre,** repeating one when there are fewer liked genres than rounds. Play another genre only when the venue asks for it tonight.
- **A remembered difficulty is where a genre starts tonight.** After each round, if the room found that genre easy, play its next round tonight one step harder; if it struggled or left many answers blank, one step easier. Never change a round once its questions are out, and say any change when you announce the round. Remember the level each genre should start at next time.
- **Move each difficulty from on-level evidence:** for each genre played, judge it only on its questions whose own difficulty matched the difficulty you planned; each question you were given carries its difficulty. Move the planned difficulty one step toward how the room did on those: harder when easy, easier when it struggled or left many answers blank, unchanged when it suited the room. Keep it when few were on-level.
- **Before you finish:** call `round_summary`, then rewrite the `Next night` plan, never append to it. Then add one dated log line: which genres and difficulties you ran and how each did.
- Set `region` to the venue's region on every `next_questions` call.
- A request that applies to tonight only is never kept as a lasting setting.
- Never store team names, scores or the questions asked: the bank keeps those.
