# Cover the API reference sync with live tests

You are running in GitHub Actions, started by `.github/workflows/api-contract-fix.yml`.
An earlier job in the same run brought the SDK back in sync with the published
API reference and pushed the fix to the branch `bot/api-contract-sync`. This
checkout is that branch (or the live-test branch stacked on it), so the SDK
already contains the fix.

The fix PR listed the SDK operations it added or changed. That list is
appended below this file under "Live tests to add". It is your task list:
cover what it lists and nothing else.

Read `AGENTS.md` before you edit anything and follow it.

## What to change

For each item in the list, make the live suite in `tests/live/` exercise the
operation and the fields named against a real deployment:

- If a walk already covers the operation (for example `files CRUD walk` for
  `client.files.*`), extend that walk: send the new parameter, and assert the
  new response field.
- Otherwise add a new `it("<resource> CRUD walk", ...)` inside the existing
  `describe("live API", ...)` in `tests/live/live-api.test.ts`.
- If the list says "Not listed by Claude", derive the operations from
  `git diff origin/main -- packages/` and cover those.

Write them in the style of the existing suite in `tests/live/live-api.test.ts`:

- Get the client with `liveClient(ctx, credential)`. Use `"serviceAccount"`
  unless the route needs a scope only a member holds (`"member"`, `"session"`).
  A missing setting skips the test; never read `process.env` directly.
- Name everything with `unique(prefix)`, read listings with `collect(...)`,
  and assert error responses with `expectStatus(promise, ErrorClass, status)`.
- Each test creates what it reads and deletes it again, in `try`/`finally` when
  a later step can fail, so it holds no state between runs.
- Nothing goes through Polly or a mock: these requests must reach the stack.
- Assert what the API answers (the field is present, round-trips, filters the
  listing), not just that the call did not throw.

## What not to change

- Edit only files under `tests/live/`. Never edit the SDK packages, the unit
  tests, `scripts/check-api-contract.mjs` or anything under `.github/`.
- If an item cannot be tested without an SDK change, change nothing for it and
  say why in your notes.
- Never weaken, skip or delete an existing live test.
- Do not run `git commit` or `git push`. The workflow commits and opens the PR.

You cannot run the suite against a deployment here: there is no stack and no
credentials, so every live test skips. Someone runs it against a stack before
the PR merges.

## When you are done

You are done only when all of these pass:

```bash
pnpm check-types
pnpm exec eslint tests/live
pnpm exec prettier --check tests/live
pnpm test:live
```

`pnpm test:live` runs without `INTROSPECTION_LIVE`, so it only proves that the
suite compiles and collects. Run `pnpm build` first if a workspace package
cannot be resolved, and `pnpm exec prettier --write tests/live` to format.

Finally, write `.api-contract-fix/live-notes.md` (the workflow keeps it out of
the commit and puts it into the PR) with one `##` heading per part:

1. **Tests**: one line per list item, naming the test (walk) that now covers
   it and what it asserts.
2. **Not covered**: one line per list item you left alone, and why. Write
   "None" if there are none.
3. **Checks**: the result of each of the four commands above.
