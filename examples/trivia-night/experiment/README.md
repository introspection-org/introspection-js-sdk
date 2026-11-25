# The memory experiment

The scripts behind [`PREREGISTRATION.md`](../PREREGISTRATION.md). They sit outside the Recipe, so `recipe-operator/` stays exactly what a venue runs.

| File                   | What it does                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `night-series.eval.ts` | The frozen series `improve/memory` searches with. One pub's two nights under Vitest: night 1 writes the notes, a fresh session plays night 2 from them, and the pub's own `check.mjs` scores night 2.   |
| `run-series.sh`        | Runs that suite for one Recipe folder, pub and arm (`hosted` or `fresh`), with no API key in its environment, so the model runs on your Pi sign-in.                                                     |
| `analyze.mts`          | The pre-registered analysis of a platform run, read from its trial tasks as the member `introspection login` signed in: arm means, the validity gate, paired intervals, sign tests and Holm correction. |

```sh
pnpm install --dir experiment  # for the series
node --env-file-if-exists=.env.local --import tsx experiment/analyze.mts <run-id>  # as the CLI's signed-in member
```
