# Spike: a trial in the browser, as the signed-in member

Can the trivia-night page run a trial through the JS SDK alone, with the signed-in member's token and no CLI, Harbor or API key file? `sdk-trial.mts` does one trial the way the CLI's Harbor platform environment does, against the Data Plane:

1. builds the task's fakes sidecar as an image from an uploaded `fakes/` archive (`files.upload`, `images.create`);
2. creates a `kind: eval` task at a Recipe commit, with the sidecar in `compose` and a pub identity in `metadata.identity`;
3. runs the night's instruction (`tasks.runs.create`);
4. uploads the task's tests, runs its verifier and downloads `reward.json` (`tasks.commands`).

The member token in the test was the CLI login's access token, the same kind of token a `spa` application's authorization-code exchange returns: the signed-in business member, not the application's agent.

## What it showed

| Question                                                             | Answer                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create an eval task at a commit with the fakes sidecar, as a member? | **Yes.** `POST /v1/tasks` takes `recipe_git_commit_sha` and `compose` on `kind: eval`; night 0 at Sydney ran, ready in 6–8 s. The JS SDK's `TaskCreateParams` lacks both fields, so the script casts the body.                                                                                     |
| Keep memory per pub identity?                                        | **No.** The identity is recorded, but `memory` is null: the Data Plane keys memory by an asserted identity only for an agent member (`_memory_owner_key`), and a `spa` sign-in is the business member. Nor can the browser mint an agent key: `api_keys:*` is outside every application's ceiling. |
| Run the verifier and read `reward.json`?                             | **Yes.** Upload, exec and download through `tasks.commands` gave `{"reward":1,"notes_seeded":1}`.                                                                                                                                                                                                  |
| Attributed to the member?                                            | **Yes.** The task's `member_id` is the signed-in member.                                                                                                                                                                                                                                           |

A compose `build.context` must be an uploaded archive's file id, so the browser either builds a `.tar.gz` of `fakes/` itself or reuses a ready image from the catalog: images are deduplicated by content, and the fakes change rarely.

## Run it

```sh
TOKEN_FILE=<file holding a member token or key> DP_URL=<data plane URL> \
RUNTIME_ID=<trivia-host runtime> COMMIT=<trivia-host commit> \
TASK_DIR=recipe-operator/evals/harbor/night0-sydney FAKES_DIR=recipe-operator/fakes \
node --import tsx spike/sdk-trial.mts
```

`TOKEN_JSON_FIELD=access_token` reads the token from a JSON file such as the CLI's `~/.introspection/credentials.json`. Generate the tasks first with `node recipe-operator/evals/venues.mjs`.

## Setting up the page on your platform

Register the page as a `spa` application on your project (Max or Enterprise plan), with the evals and images scopes named, since an application's default leaves them out:

```sh
introspection applications create --type spa --name "Trivia night" \
  --redirect-uri https://<your host>/callback --allowed-origin https://<your host> \
  --allowed-scope tasks:read --allowed-scope tasks:write \
  --allowed-scope tasks:eval --allowed-scope tasks:exec \
  --allowed-scope files:read --allowed-scope files:write \
  --allowed-scope images:read --allowed-scope images:write \
  --allowed-scope conversations:read
```

This targets `https://api.introspection.dev` and the production lane; `--url` and `-e` point it at another platform or lane. You need those scopes yourself, as an org admin or owner, since an application's are capped at its creator's.

## What has to land for the page to run as an SPA

- **cloud, the blocker:** memory per pub for a member's trials. For example, a `kind: eval` task a member creates owns memory by its asserted identity in a reserved simulation namespace (`anon:sim-…`). This changes who owns memory, so it needs design review. The alternative needs no change: a small server route that runs trials as a `service_account` application (the `examples/auth` broker), at the cost of attributing tasks to the app's agent with the member named only in caller metadata.
- **JS SDK:** `compose` and `recipe_git_commit_sha` on `TaskCreateParams`, an image's pinned pull reference, and a trial helper (sidecar, task, tests, verifier) the page and other evals can share.
- **trivia-night page:** sign-in and `/callback` from `examples/auth`, the sidecar archive built in the browser or a catalog image, and the run loop moved client-side; the tab stays open for the run.
- **CLI:** nothing.
