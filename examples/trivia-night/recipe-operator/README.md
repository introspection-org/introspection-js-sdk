# Starter Template

A minimal Pi coding agent with repository inspection, shell, and file-editing tools.

## Quick start

Install Node.js 24 or newer and the Introspection CLI, then create your own recipe from this template. `init` also installs the compatible Pi harness and Recipes extension.

```bash
npm install -g @introspection-ai/cli
introspection init trivia-host template-starter
cd trivia-host
```

Validate the recipe and start a fresh local Pi session:

```bash
introspection local --runtime trivia-host
```

Ask:

> Inspect this repository and summarize its structure. Do not change any files.

The local loop needs no Introspection login or cloud runtime. Pi may ask you to configure the model provider on the first run.

## Move the recipe through its lifecycle

The everyday flow is:

```text
Local Pi → Development → Staging → Production → Learn and repeat
```

### 1. Change and prove it locally

Customize `SYSTEM.md` and `agents/agent.yaml`, then repeat the local prompt above in fresh sessions. Test any new tools or instructions as well as ordinary coding requests that should keep working.

### 2. Create the runtime and test development

Development requires the recipe's first runtime. Commit the locally proven recipe, push it to your own GitHub repository, then:

1. In the Introspection app, open your organization's **Integrations** page and grant the Introspection GitHub App access to the repository.
2. Open the target project, go to **Runtimes**, and select **New runtime**.
3. Choose the repository and the runtime in `.introspection/trivia-host.yaml`, confirm that its recipe path is `.`, and create the first version from `main`.
4. In **Versions**, confirm that the immutable version's recipe commit matches the `main` commit you intended to deploy.

Once the runtime exists, exercise uncommitted changes through the cloud development path:

```bash
introspection login
introspection dev --runtime trivia-host
```

Leave the command running, open the development chat URL it prints, and repeat the repository-summary prompt. Saved changes to `SYSTEM.md` or `agents/agent.yaml` are picked up without a commit or push. Stopping `introspection dev` removes the local overlay; it does not deploy a version.

### 3. Verify a pull-request candidate in staging

Push a feature branch and open a pull request. The GitHub integration creates an immutable candidate version for that commit; do not create another runtime for the same agent.

In the runtime's **Versions** view, find the candidate by branch and commit, pin it to **Staging**, and select **Preview**. Repeat the repository-summary prompt and confirm that the conversation used the intended candidate commit without an unhandled error.

### 4. Merge it to production

After the staging behavior and pull request are approved, merge into the repository's configured production branch. The GitHub integration creates the immutable version and activates it for production; there is no separate promotion command.

Run one small production check through the stable `trivia-host` runtime and confirm that it resolves to the merged recipe commit.

### 5. Learn and repeat

Use production conversations and recurring patterns to choose the smallest useful change, then return to the local loop. See the [agent development lifecycle](https://docs.introspection.dev/guides/development-lifecycle) for the full workflow.

## What's included

- A ready-to-run Pi coding agent
- Shared behavior in `SYSTEM.md`
- Model and tool configuration in `agents/agent.yaml`
- Conversation starters in `prompts/`: Pi prompt templates (listed in `package.json` under `pi.prompts`) offered when a new conversation opens, in Pi and as chips in the Introspection chat, when their frontmatter has `suggest: true`. Replace them with two to four requests of no more than 10 words that your agent handles; each also works as `/<name>`
- Runtime metadata in `.introspection/trivia-host.yaml`
- `.recipeignore`, which keeps evals (`evals/`, when you add them) out of the deployed recipe

[Read the Recipes documentation →](https://docs.introspection.dev/recipes)
