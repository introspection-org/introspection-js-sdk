---
id: memory-write
title: After a night, the notes hold what was learned and nothing said for tonight only
sources: [trivia-bank]
check: code
---

## Situation

The Quiz & Quill has just played its first night. In the bank, its science round was 100% right, its history round 67% and a music round 17%. The trivia master says the night is over, that the venue is in Oxford and loves science and history, and that the music round was only for a regular's birthday.

## A good result

The host leaves a notes file under `/workspace/memories` naming the venue's region and its liked genres, science and history, with science pitched harder than 3. Music is not noted as something the venue likes.

## A bad result

- No notes file exists after the night.
- The region or a liked genre is missing.
- Science stays at difficulty 3 after a round everyone got right.
- The birthday music round is kept as a lasting liking.

## Verification

The verifier reads the notes files in `/workspace/memories` after the run.
