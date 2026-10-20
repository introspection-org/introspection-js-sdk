# Sync the SDK with the published API reference

You are running in GitHub Actions, started by `.github/workflows/api-contract-fix.yml`
because `node scripts/check-api-contract.mjs` reported drift between this SDK and
the published API reference. The check's output is appended below this file under
"Drift report". It is your task list: fix what it lists and nothing else.

Read `AGENTS.md` before you edit anything and follow it.

## What to change

For each item in the drift report:

- **Accepted by the API but missing from the SDK**: add the field or query
  parameter to the interface the report names, with the type and a doc comment
  taken from the reference.
- **Declared here but not accepted / not returned by the API**: remove it from
  the interface, and remove every use of it in the SDK packages.
- **Renamed** (one name missing, a matching one extra): rename it, and update
  every use.
- **Type changes the item implies**: update the types in
  `packages/introspection-types` and the browser client in
  `packages/introspection-browser` so they agree with each other.
- Add or adjust unit tests under `tests/` that cover what you changed.

The reference itself is at `https://docs.introspection.dev/openapi/dataplane.json`
and `https://docs.introspection.dev/openapi/controlplane.json`; read it with
`node scripts/check-api-contract.mjs` rather than by fetching it yourself.

## What not to change

- Never edit `scripts/check-api-contract.mjs`: not its reference URLs, and not
  its allowlist (the `exempt`, `allowedExtra` and SDK-only declarations).
- Never edit anything under `.github/`.
- Never weaken, skip or delete a test, and never lower a coverage threshold.
- Do not refactor, reformat or touch code the drift report does not reach.
- Do not run `git commit` or `git push`. The workflow commits and opens the PR.

## Questions instead of changes

Some items should not be fixed by you. Write them as questions instead:

- A change that breaks the SDK's **public API** for existing callers (removing
  or renaming an exported type, field or parameter that callers may use). Make
  no change for it, and explain who it breaks.
- An item that may belong on the **allowlist** instead (a deliberate SDK-only
  field, a field the SDK intentionally does not expose, or an exemption the
  report calls stale). Make no change for it, and say which allowlist entry a
  maintainer would add or drop.

## When you are done

You are done only when all three of these pass:

```bash
node scripts/check-api-contract.mjs
pnpm check-types
pnpm --filter introspection-tests test
```

Run `pnpm build` first if the tests cannot resolve a workspace package. A
check that still fails only because of an item you turned into a question is
acceptable; say so.

Finally, write `.api-contract-fix/pr-notes.md` (the workflow keeps it out of
the commit and puts it into the PR) with:

1. **Changes**: one line per drift item you fixed, naming the interface and the
   field or parameter.
2. **Questions for a maintainer**: one line per item you left alone, and why.
   Write "None" if there are none.
3. **Checks**: the result of each of the three commands above.
