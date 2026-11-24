# The memory experiment

The scripts behind [`PREREGISTRATION.md`](../PREREGISTRATION.md). They sit outside the Recipe, so `recipe-operator/` stays exactly what a venue runs.

| File                   | What it does                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `night-series.eval.ts` | One pub's two nights under Vitest: night 1 writes the notes, a fresh session plays night 2 from them, and the pub's own `check.mjs` scores night 2.     |
| `run-series.sh`        | Runs that suite for one Recipe folder, pub and arm (`hosted` or `fresh`), with no API key in its environment, so the model runs on your Pi sign-in.     |
| `search.py`            | The self-improvement search: from the original Recipe's empty memory block, a fixed proposer writes new blocks, each scored on the 11 development pubs. |
| `analyze.mts`          | The pre-registered analysis of a platform run: arm means, the validity gate, paired intervals, sign tests and Holm correction.                          |

```sh
pnpm install --dir experiment
python3 experiment/search.py                       # search.log, search.json, FINAL_BLOCK.md
node --import tsx experiment/analyze.mts <run-id>  # with the page running on :3500
```

`run-series.sh` and `search.py` need the `introspection` and `pi` CLIs on your path, signed in to Pi.
