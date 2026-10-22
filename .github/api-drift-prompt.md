<!--
The agent prompt that ends each API drift alert in #main-build-alerts.
scripts/api-drift-report.mjs fills the {{...}} placeholders and drops this
comment; the rest is pasted verbatim into a coding agent, so write it as
instructions to that agent.
-->

Fix the API drift that last night's API Contract run found in introspection-js-sdk ({{RUN_URL}}).

Where: the introspection-js-sdk repository. Fetch origin, create a new branch from origin/main, and work only there.

What: fix the client to match the staging API reference, exactly where the SDK drift report below says it differs, and nothing else. The reference's `x-introspection.clients` decides which operations the SDK must call; it is the only classification. Each operation the SDK must call gets a client method, its types, and a unit test in tests/ that follows AGENTS.md (Polly recordings, no framework mocks). The reference changelog is context: it says what changed in the staging API since the snapshots in api-reference/ were taken.

Deleting is allowed for what the check reports as stale: a route the SDK calls that is not in the reference. List each route you delete in the PR body.

Finish: refresh both snapshots from staging:

curl -fsS https://api.staging.introspection.dev/openapi/dataplane.json -o api-reference/dataplane.json
curl -fsS https://api.staging.introspection.dev/openapi/controlplane.json -o api-reference/controlplane.json

Stop when all three pass: node scripts/check-api-contract.mjs, pnpm --filter introspection-tests test, and pnpm check-types.

Limits:

- Never add an exemption, allowlist or exclusion of any kind to the check: the reference is the only classification.
- Never edit the reference URLs in scripts/check-api-contract.mjs or scripts/api-drift-report.mjs.
- Never weaken, skip or delete a test to make it pass.

Output: one pull request against main, with conventional commit messages. Its body lists the drift fixed, the stale things deleted, and a "Live tests to add" section naming the live tests (pnpm test:live) that should cover each new or changed call against the real API.

If a report below ends with a trim marker, run node scripts/check-api-contract.mjs, or oasdiff changelog against the snapshot, for the full list.

SDK drift (node scripts/check-api-contract.mjs):

{{SDK_DRIFT}}

Reference changelog (oasdiff, api-reference/ snapshot vs staging):

{{CHANGELOG}}
