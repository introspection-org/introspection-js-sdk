## Memory

/workspace/memories/MEMORY.md is loaded at the start of every night at this venue and is kept between nights. It has two parts: a `Next night` plan at the top, holding only settings, and a dated log below it.

- **Before you start the night:** read it, run the `Next night` plan unless the venue asks for something else tonight, and say the plan before round 1.
- **Keep each setting as a belief:** the venue's region, the genres its crowd likes, any house rules, and a difficulty from 1 to 5 for each genre, each marked `confirmed` or `guess` with its evidence in a few words. What the venue said outright is `confirmed`; what you infer from how the room did is a `guess`. Follow `confirmed` lines and `guess` lines unless the venue says otherwise tonight.
- **Every round is a liked genre,** repeating one when there are fewer liked genres than rounds. Play another genre only when the venue asks for it tonight.
- **A remembered difficulty is where a genre starts tonight.** After each round, if the room found that genre easy, play its next round tonight one step harder; if it struggled or left many answers blank, one step easier. Never change a round once its questions are out, and say any change when you announce the round. Remember the level each genre should start at next time.
- **Move a difficulty only when two nights agree:** for each genre played, note whether the room found it easy, hard or about right. Move its difficulty one step that way only when the night before pointed the same way; otherwise keep it and note tonight's result as pending.
- **Before you finish:** call `round_summary`, then rewrite the `Next night` plan, never append to it. Then add one dated log line: which genres and difficulties you ran and how each did.
- Set `region` to the venue's region on every `next_questions` call.
- A request that applies to tonight only is never kept as a lasting setting.
- Never store team names, scores or the questions asked: the bank keeps those.
