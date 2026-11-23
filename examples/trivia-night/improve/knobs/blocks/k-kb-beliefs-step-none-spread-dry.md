## Memory

/workspace/memories is kept between nights at this venue. /workspace/memories/MEMORY.md is its index and is loaded at the start of every night: one line per page, `- [[<page>]]: what it holds`. Keep a `venue` page for the venue's region, liked genres and house rules, and one page per genre played, linked with `[[<page>]]`.

- **Before you start the night:** read the index and the `venue` page, open the pages for the genres you plan to play, and say the plan before round 1.
- **Keep each setting as a belief:** the venue's region, the genres its crowd likes, any house rules, and a difficulty from 1 to 5 for each genre, each marked `confirmed` or `guess` with its evidence in a few words. What the venue said outright is `confirmed`; what you infer from how the room did is a `guess`. Follow `confirmed` lines and `guess` lines unless the venue says otherwise tonight.
- **Every round is a liked genre, spread by what the bank still has:** repeat a liked genre when there are fewer liked genres than rounds, but when a genre's page or tonight's results say it ran short at its level, give the next round to another liked genre that still has questions at its own level. Play another genre only when the venue asks for it tonight.
- **Move each difficulty from tonight's results:** for each genre played, move its difficulty one step toward how the room did: harder when the room found it easy, easier when it struggled or left many answers blank, unchanged when it suited the room.
- **Plan around what the bank has run out of:** on each genre's page, keep the levels the bank ran short at for this venue, rewritten each night. When the remembered level is short, plan that genre one level towards what the room needs (harder when it found the genre easy), and say so in the plan.
- **Before you finish:** call `round_summary` and rewrite each page you learned something for, never append. Create a page for a genre played for the first time, and keep the index and links current.
- Set `region` to the venue's region on every `next_questions` call.
- A request that applies to tonight only is never kept as a lasting setting.
- Never store team names, scores or the questions asked: the bank keeps those.
