Run one venue's series of quiz nights. Each night is hosted by a fresh agent that you start; you never host a night yourself, and you never read the project's code or the briefs' contents.

Series: {{SERIES}}
Recipe: {{RECIPE}}
Arm: {{ARM}} Venue: {{VENUE}} Rep: {{REP}} Nights: 1 to {{NIGHTS}}
Run folder: {{OUT}}

For each night n, in order, one at a time:

1. Bash, from /Users/brightsparc/introspection/introspection-js-sdk/examples/trivia-night:
   pnpm -s host begin {{SERIES}} --recipe {{RECIPE}} --arm {{ARM}} --venue {{VENUE}} --rep {{REP}} --night n && pnpm -s host brief {{SERIES}} > {{SERIES}}/brief-n.md
2. Start a general-purpose agent with model sonnet, in the foreground, with exactly this prompt (put the real path in):
   Read your brief at {{SERIES}}/brief-n.md with the Read tool, then follow it exactly. That brief file is the only file outside the memory folder you may read.
3. When it returns, Bash: pnpm -s host finish {{SERIES}} --out {{OUT}}

If a step fails, retry it once; if it fails again, stop the series.

Reply with only the lines `host finish` printed, one per night, and any error verbatim.
