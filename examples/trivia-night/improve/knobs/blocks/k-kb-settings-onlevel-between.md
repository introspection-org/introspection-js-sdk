## Memory

/workspace/memories is kept between nights at this venue. /workspace/memories/MEMORY.md is its index and is loaded at the start of every night: one line per page, `- [[<page>]]: what it holds`. Keep a `venue` page for the venue's region, liked genres and house rules, and one page per genre played, linked with `[[<page>]]`.

- **Before you start the night:** read the index and the `venue` page, open the pages for the genres you plan to play, and say the plan before round 1.
- **Keep only settings you will use:** the venue's region, the genres its crowd likes, any house rules, and a difficulty from 1 to 5 for each genre. Write each with one line on why it last changed.
- **Every round is a liked genre,** repeating one when there are fewer liked genres than rounds. Play another genre only when the venue asks for it tonight.
- **A remembered difficulty is where a genre starts tonight.** After each round, if the room found that genre easy, play its next round tonight one step harder; if it struggled or left many answers blank, one step easier. Never change a round once its questions are out, and say any change when you announce the round. Remember the level each genre should start at next time.
- **Move each difficulty from on-level evidence:** for each genre played, judge it only on its questions whose own difficulty matched the difficulty you planned; each question you were given carries its difficulty. Move the planned difficulty one step toward how the room did on those: harder when easy, easier when it struggled or left many answers blank, unchanged when it suited the room. Keep it when few were on-level.
- **Before you finish:** call `round_summary` and rewrite each page you learned something for, never append. Create a page for a genre played for the first time, and keep the index and links current.
- Set `region` to the venue's region on every `next_questions` call.
- A request that applies to tonight only is never kept as a lasting setting.
- Never store team names, scores or the questions asked: the bank keeps those.
