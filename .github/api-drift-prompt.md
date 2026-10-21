<!--
The agent prompt that ends each API drift alert in #main-build-alerts.
scripts/api-drift-report.mjs fills the {{...}} placeholders and drops this
comment; the rest is pasted verbatim into a coding agent, so write it as
instructions to that agent.
-->

Fix the API drift that last night's API Contract run found in introspection-js-sdk ({{RUN_URL}}).

Where: the introspection-js-sdk repository. Fetch origin, create a new branch from origin/main, and work only there.

What: fix exactly the drift listed in the SDK drift report below, and nothing else. Each fix covers the SDK types, the client code that sends or reads the field, and a unit test for it in tests/ that follows AGENTS.md (Polly recordings, no framework mocks). The reference changelog is context: it says what changed in the published API since the snapshots in api-reference/ were taken.

Finish: when the drift is fixed, refresh both snapshots from the live reference:

curl -fsS https://docs.introspection.dev/openapi/dataplane.json -o api-reference/dataplane.json
curl -fsS https://docs.introspection.dev/openapi/controlplane.json -o api-reference/controlplane.json

Stop when all three pass: node scripts/check-api-contract.mjs, pnpm --filter introspection-tests test, and pnpm check-types.

Limits:

- Never edit the reference URLs in scripts/check-api-contract.mjs.
- Never add or widen an exemption, allowedExtra or allowlist entry, and never add an "excluded" entry to scripts/api-contract/operations.json. The only allowed edit to either is deleting an entry the check reports as stale ("exempted here but no longer in the API"); list each one you delete in the PR body.
- Never weaken, skip or delete a test to make it pass.

Questions, not changes: put these in the PR body as questions and leave the code alone.

- An SDK API break: a fix that would remove or retype something callers of the SDK use today, such as a parameter the API no longer accepts. Ask whether to break it now or deprecate it first.
- An unclassified operation: an endpoint the changelog adds or removes that the SDK neither covers nor excludes. Ask "add to SDK or exclude?" for each.

Output: one pull request against main, with conventional commit messages. Its body lists the drift fixed, the stale entries deleted, the questions above, and a "Live tests to add" section naming the live tests (pnpm test:live) that should cover each new or changed call against the real API.

If a report below ends with a trim marker, run node scripts/check-api-contract.mjs, or oasdiff changelog against the snapshot, for the full list.

SDK drift (node scripts/check-api-contract.mjs):

{{SDK_DRIFT}}

Reference changelog (oasdiff, api-reference/ snapshot vs live docs.introspection.dev):

{{CHANGELOG}}
