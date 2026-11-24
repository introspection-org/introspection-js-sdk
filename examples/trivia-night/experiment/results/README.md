# Trivia-night memory study: results

A quiz-hosting agent plays two nights at each simulated pub, and every measure is computed from the crowd's answers by code, with no model judging. **H1 is supported.** On 20 held-out pubs, analysed as pre-registered, a host that keeps its own notes ran a better second night than one with no notes. It also beat a host given another pub's notes (15 pubs to 1), so it is what the notes say that helps. Memory carried taste: loved genres were played far more often. It did not carry level: the first round was not pitched right more often. **H2 is not supported as pre-registered.** The test compared a self-improved memory, written by the Introspection Operator's improve-memory skill on the development pubs only, with the original recipe's lack of memory instructions. The pre-registered measure is a share of the rounds a night actually played, and three hosts without memory instructions stopped after one round. Counted out of each night's 6 rounds, an exploratory analysis chosen after seeing the data shows good rounds going from 1.1 to 2.1.

The full report is `report.html` in this folder. Download it and open it in a browser; it is a single self-contained page with interactive charts.

## H1: does memory help, and is it the content?

20 held-out pubs, model notes against no notes. Good rounds are rounds in a loved genre and 55–75% right, per night, out of 6.

| Question                      | Model notes | No notes  | Difference         |     |
| ----------------------------- | ----------- | --------- | ------------------ | --- |
| Good rounds of 6 (primary)    | 1.8         | 1.2       | +0.6 [0.3, 1.0]    | ✓   |
| More than another pub's notes | 1.7         | 0.9 other | 15 better, 1 worse | ✓   |
| Rounds in a loved genre       | 59%         | 33%       | +26 pts            | ✓   |
| First round pitched right     | 60%         | 47%       | +13 pts (chance)   | ✗   |

✓ supported · ✗ not supported. The primary pairs the 19 pubs with both nights: as a share of rounds, +0.10 [0.04, 0.16]. The other-notes comparison uses a sign test, p = 0.0005. Secondaries are Holm-corrected: loved genres p < 0.0001, first round p = 0.73. The order true ≥ model > none > other holds: 1.8 ≥ 1.7 > 1.2 > 0.9.

## H2: does the self-improved memory beat no memory instructions?

The same 20 held-out pubs.

| Question                   | Self-improved | No memory | Difference       |     |
| -------------------------- | ------------- | --------- | ---------------- | --- |
| Good rounds of 6 (primary) | 2.2           | 1.7       | +0.5 [−0.5, 1.4] | ✗   |
| Rounds in a loved genre    | 70%           | 39%       | +31 pts [17, 45] | ✓   |
| Rounds 55–75% right        | 56%           | 61%       | −5 pts [−23, 12] | ✗   |
| First round pitched right  | 53%           | 47%       | +5 pts (chance)  | ✗   |

The primary here is the pre-registered share of rounds played, multiplied by 6, over 19 pubs. As a share it is +0.08 [−0.08, 0.23], with 13 pubs better and 3 worse.

These analyses were chosen after seeing the data, so they are exploratory:

| Analysis                                   | Pubs | Difference, good rounds of 6 |
| ------------------------------------------ | ---- | ---------------------------- |
| Counted out of 6, unplayed rounds not good | 20   | +1.00 [+0.50, +1.50]         |
| Only nights that played all 6 rounds       | 16   | +0.94 [+0.31, +1.57]         |
| Pre-registered measure, Edinburgh as 0     | 20   | +0.49 [−0.39, +1.37]         |
| Pre-registered measure, without Austin     | 18   | +0.43 [−0.55, +1.42]         |

The self-improved memory against the hand-written memory used for H1 is reported, not tested: +0.4 good rounds of 6 [0.0, 0.7]. It pairs pubs across the two separate runs.

## Deviations

- **H1, Newcastle:** the no-notes host played no rounds, so the primary uses 19 pubs.
- **H1, placebo:** the other-notes condition used an older planner. Pubs could share one donor, whose notes were loaded as rewritten after its night 2 rather than from night 1. It still carried another pub's tastes.
- **H2, Edinburgh:** the host with no memory instructions played no rounds, so the pub is excluded from the primary.
- **H2, one-round nights:** with no memory instructions, the night-2 host stopped after one round at Denver, Nottingham and Sheffield. The pre-registered share scores one good round followed by stopping as a perfect night.
- **H2, Austin:** the no-memory night 2 failed three times before its host ran, then succeeded on the fourth attempt:
  - first, a control-plane error while Docker was down;
  - then two git fetch failures while the git server was down.

  This is beyond the one-rerun rule. The primary without Austin reaches the same verdict.

- **H2, reruns:** 20 nights were rerun. Every one had failed before its host ran, and each was rerun as the same customer identity.

## Runs and commits

- **Pre-registration:** tag `trivia-night-prereg-v1`, commit `200a9f72`.
- **Recipes:**
  - hand-written memory (H1): `393c952`;
  - no memory instructions (H2 baseline): `18b2845`;
  - self-improved memory (H2): `ca51467`.
- **Self-improved memory text:** sha256 `cc6a4c394ded0a87a09a8ea82b6d3c60393132fc9bcc44a543d346acfb4b8455`.
- **Development run:** `r1795541226673`, 11 pubs.
- **H1 held-out run:** `r1795554068560`, 20 pubs, 120 trials.
- **H2 held-out run:** `h1795554094`, 20 pubs, 40 night-2 trials.
- **Host model:** `anthropic/claude-sonnet-5-5`.

## Since these runs

The night-2 verifier now counts good rounds and loved-genre rounds out of the night's 6, records `rounds_played`, and gives a reward only to a night that played all 6. A future pre-registration should use that measure.
