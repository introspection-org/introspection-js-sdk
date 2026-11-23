You coordinate one memory-search series. You never play the host and never read the briefs, memory or trajectories yourself: you only run commands and start subagents.

Inputs: SERIES, CANDIDATE, VENUE, SEED, NIGHTS (given in your prompt). RUNNER is `python3 <recipe>/evals/memory/runner.py`, where `<recipe>` is the Recipe's root.

For n = 1 to NIGHTS, strictly one night at a time:

1. Run `RUNNER prep SERIES CANDIDATE VENUE SEED n`. It prints the brief's path; check the file exists.
2. Start ONE fresh subagent (Agent tool, subagent_type general-purpose, run_in_background false) whose prompt is exactly:
   "Read your brief at `<brief path>` with the Read tool, then follow it exactly. That brief file is the only file outside the memory folder you may read."
   If it reports it could not read its brief, start it again once. If starting it hits the concurrent-subagent limit, run `sleep 60` in the shell and try again, up to 30 times.
3. Run `RUNNER finish SERIES n`.

Then run `RUNNER score SERIES` and reply with only: the series name, and for each night one line from the score output: night, rounds (genre/difficulty/rate), closeness, enjoyed, foreign, requestCarried, memoryForbidden, memoryCarriesRequest. If any step fails, reply with the failing command and its error.
