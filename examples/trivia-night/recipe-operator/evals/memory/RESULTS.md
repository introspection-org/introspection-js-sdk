# improve-memory m1: results (2026-11-23)

In-session search over the memory block only. The world, venues and metrics are in `brief.md`. Off-target means how far each round's share of right answers lands from 2/3, averaged over nights 2+ (lower is better). Enjoyed is the share of rounds in genres the crowd enjoys (request night excluded). Every series below had 0 rule breaks: no other-country questions, nothing forbidden in the notes, and no one-night request carried over.

## Training venues (4 nights; paired seed 101; control's own seed-to-seed spread ~0.05 per venue)

| Candidate               | Off-target mean (worst)             | Enjoyed mean |
| ----------------------- | ----------------------------------- | ------------ |
| control (current block) | 0.170 (0.194), 0.190 incl. seed 202 | 0.67         |
| freeform                | 0.154 (0.199)                       | 0.67         |
| datedlog                | 0.154 (0.185)                       | 0.69         |
| beliefs                 | 0.156 (0.190)                       | 0.67         |
| nextaction              | 0.145 seed 101; ~0.15 over 2 seeds  | 0.78         |
| nextaction-rev          | 0.139 (0.157)                       | 0.72         |
| **beliefs-rev**         | **0.125 (0.153)**                   | **0.72**     |

## Held-out venues (8, never shown to the meta agent; 3 nights; beliefs-rev vs control, paired)

| Venue kind       | beliefs-rev       | control           | diff                  |
| ---------------- | ----------------- | ----------------- | --------------------- |
| narrow (1)       | 0.146             | 0.174             | -0.028                |
| shifting (2)     | 0.160             | 0.194             | -0.035                |
| mismatch (3)     | 0.160             | 0.160             | 0.000                 |
| low              | 0.174             | 0.250             | -0.076                |
| high             | 0.132             | 0.097             | +0.035                |
| narrow (6)       | 0.139             | 0.160             | -0.021                |
| shifting (7)     | 0.153             | 0.118             | +0.035                |
| mismatch (8)     | 0.118             | 0.215             | -0.097                |
| **mean (worst)** | **0.148 (0.174)** | **0.171 (0.250)** | **-0.023 ± 0.017 SE** |

Enjoyed on held-out: beliefs-rev 0.71, control 0.58 (worst 0.33 for both, on a shifting venue).

The held-out gain is modest: 1.4 standard errors, with 2 of 8 venues worse. The worst venue improves from 0.250 to 0.174.

## Fixes to the measurement during the run (none changes a scored night's world)

- Memory guards gave false positives on "less keen", "liked genres", "2 of 3" and "standing preference". Tightened, with each line added as a test, and every series rescored.
- Hosts given a long or relative series path wrote to a stray world. A per-series `tool` command with the absolute path fixes this. Affected series were rerun from night 1.
- The trivia master fake missed rounds whose questions ran together on one line, which stalled one held-out night. The detector now counts inline questions, and that series was rerun.

## Second held-out seed: decision rule (set by the owner 2026-11-23, written before any seed-202 result)

Both beliefs-rev and control play the 8 held-out venues again, seed 202, 3 nights each, paired. Then:

- **Per venue:** d_v = mean over the two seeds of (beliefs-rev off-target − control off-target).
- **Combined gain:** G = −mean(d_v) over the 8 venues. Its standard error is SE = stdev(d_v)/√8, with the venue as the unit. The 16-pair figure is reported too, for reference only.
- **Control's seed-to-seed spread:** S = mean over the 8 venues of |control seed 101 − control seed 202|.
- **Adopt beliefs-rev only if** G > 2·SE **and** no venue has d_v > S. Otherwise keep the current block.
- **No deploy either way.**

## Second held-out seed: result (2026-11-23)

The output of `decide.py` is saved in `decision-seed202.txt`. The 16 series (8 venues × 2 versions) ran on seed 202, 3 nights each, with 0 rule breaks.

| Venue        | beliefs-rev s101 | s202  | control s101 | s202  | d_v    |
| ------------ | ---------------- | ----- | ------------ | ----- | ------ |
| narrow (1)   | 0.146            | 0.257 | 0.174        | 0.222 | +0.003 |
| shifting (2) | 0.160            | 0.160 | 0.194        | 0.194 | -0.035 |
| mismatch (3) | 0.160            | 0.139 | 0.160        | 0.111 | +0.014 |
| low          | 0.174            | 0.188 | 0.250        | 0.174 | -0.031 |
| high         | 0.132            | 0.063 | 0.097        | 0.125 | -0.014 |
| narrow (6)   | 0.139            | 0.132 | 0.160        | 0.132 | -0.010 |
| shifting (7) | 0.153            | 0.181 | 0.118        | 0.215 | +0.000 |
| mismatch (8) | 0.118            | 0.125 | 0.215        | 0.083 | -0.028 |

- **Combined gain:** G = +0.013, SE (venue unit) = 0.006, G/SE = 2.01. Over the 16 pairs it is +0.013 ± 0.011 (1.2 SE), reported for reference only.
- **Control's seed-to-seed spread:** S = 0.057. No venue has d_v > S.
- **Verdict under the pre-registered rule:** ADOPT beliefs-rev.
- **Margin:** the gain clears the 2·SE bar by 0.01 SE, so this is a small, borderline improvement and not a decisive one.

The memory block in `SYSTEM.md` is now beliefs-rev. Nothing is deployed.

## After adoption: refinement from the approved cases (2026-11-23)

C3 found that the adopted block let the notes grow to one belief per genre and level (17 lines), against the case's "notes stay short". Two sentences were added to the block: keep one difficulty line per genre, rewritten in place, and keep profile.md short. The held-out comparison above was measured on the wording before these two sentences, so it does not strictly cover the current block. C1 to C3 all pass on the current block (`case-results/`).

## Variety guard (owner's rule, 2026-11-23) and rescore

The owner's variety rule is about 3 rounds in 5 from liked genres, so every genre still gets a turn; no memory block may override it. A guard now marks a night that breaks it: a night whose rounds are all in genres the crowd enjoys (at or above the liked threshold), with the request night excluded (`breaksVariety` in `fakes/world/score.ts`, with tests). Rescore of every series:

| Candidate                                                      | Nights | Variety broken                                          |
| -------------------------------------------------------------- | ------ | ------------------------------------------------------- |
| control                                                        | 72     | 2 (both on night 1, with empty memory)                  |
| freeform                                                       | 12     | 0                                                       |
| datedlog                                                       | 12     | 1                                                       |
| beliefs                                                        | 12     | 0                                                       |
| nextaction                                                     | 24     | 5                                                       |
| nextaction-rev                                                 | 12     | 2                                                       |
| beliefs-rev                                                    | 60     | 5 (training uk-sport n3; held-out high ×2, mismatch ×2) |
| adopted (beliefs-rev + one-line-per-genre fix, case runs only) | 10     | 0                                                       |

beliefs-rev breaks the guard, so it is **not adopted**. The current (control) block is restored in `SYSTEM.md`. The control's 2 breaks happen before memory exists; they come from the night's instructions, not from memory.

## Revision round 2 (variety rule given to the meta agent as an owner's rule), 2026-11-23

- **Parents:** the two best candidates with no guard broken on training, freeform (0.154) and beliefs (0.156).
- **Revisions:** one per parent. Each keeps a difficulty line per genre judged only from that genre's rounds, opens the night with the genre needing the lowest level, and states the variety rule. A fresh reviewer accepted both with one added line: "After the opening round only the between-round rule sets the level."
- **Runs:** 3 training venues × 4 nights, seed 101, paired with the parents.
- **Qualifying rule:** no guard broken, and a gain over the parent above the control's training seed-to-seed spread (0.046). See `selection-round2.txt`.

| Revision     | au    | uk    | us    | Mean  | Parent mean | Gain   | Guard breaks              | Qualifies |
| ------------ | ----- | ----- | ----- | ----- | ----------- | ------ | ------------------------- | --------- |
| freeform-rev | 0.106 | 0.130 | 0.106 | 0.114 | 0.154       | +0.040 | 1 (variety, uk n3)        | no        |
| beliefs-rev2 | 0.130 | 0.139 | 0.116 | 0.128 | 0.156       | +0.028 | 2 (variety, uk n4, us n4) | no        |

No revision qualifies, so nothing ran held-out and the current (control) block stays.

A false positive in the request guard was found and fixed during scoring. "…holds the first favourite round at 3…" was read as a liking for the genre named earlier in the line; the liking word must now sit within about 30 characters of the genre, and the line is a test. Every series was rescored, and no carried-request breaks remain anywhere.

### Held-out scorecard, all existing series (beliefs-rev vs control; off-target nights 2–3; V = nights breaking the variety rule)

| Venue        | beliefs-rev s101 | s202     | control s101 | s202     |
| ------------ | ---------------- | -------- | ------------ | -------- |
| narrow (1)   | 0.146 V0         | 0.257 V0 | 0.174 V0     | 0.222 V0 |
| shifting (2) | 0.160 V0         | 0.160 V0 | 0.194 V0     | 0.194 V0 |
| mismatch (3) | 0.160 V0         | 0.139 V1 | 0.160 V0     | 0.111 V0 |
| low          | 0.174 V0         | 0.188 V0 | 0.250 V0     | 0.174 V0 |
| high         | 0.132 V1         | 0.063 V1 | 0.097 V0     | 0.125 V1 |
| narrow (6)   | 0.139 V0         | 0.132 V0 | 0.160 V0     | 0.132 V0 |
| shifting (7) | 0.153 V0         | 0.181 V0 | 0.118 V0     | 0.215 V0 |
| mismatch (8) | 0.118 V1         | 0.125 V0 | 0.215 V0     | 0.083 V0 |

Under the full rule with the variety guard, beliefs-rev has 4 held-out breaks: **KEEP current block** (`decision-beliefs-rev-with-variety.txt`).

## Variety guard refined by the owner (2026-11-23) and rescore

A night breaks the variety rule only when every round is in a genre the host already had reason to think liked. That means the trivia master named it as liked (the profile's `stated`, said in the night-1 opening or held in a case's starting notes), or the room loved it in an earlier round at that venue (the trivia master's "The room loved that … round" remark, enjoyment ≥ 0.75), earlier tonight included. A genre never played or named there doesn't count. "Went down fine" is not counted as enjoyment. The request night is excluded. See `breaksVariety` in `fakes/world/score.ts` and its tests.

Rescore of every finished series (freeform-rev held-out still running):

| Candidate                        | Nights  | Variety | Forbidden | Carried | Foreign |
| -------------------------------- | ------- | ------- | --------- | ------- | ------- |
| control                          | 72      | 0       | 0         | 0       | 0       |
| freeform                         | 12      | 0       | 0         | 0       | 0       |
| datedlog                         | 12      | 0       | 0         | 0       | 0       |
| beliefs                          | 12      | 0       | 0         | 0       | 0       |
| nextaction                       | 24      | 2       | 0         | 0       | 0       |
| nextaction-rev                   | 12      | 1       | 0         | 0       | 0       |
| beliefs-rev                      | 60      | 0       | 0         | 0       | 0       |
| beliefs-rev2                     | 12      | 0       | 0         | 0       | 0       |
| freeform-rev (training)          | 12      | 0       | 0         | 0       | 0       |
| adopted / adopted-v1 (case runs) | 10 / 10 | 0       | 0         | 0       | 0       |

## freeform-rev held-out, as a training tie (owner's request, 2026-11-23)

The candidate ran on 8 held-out venues × 3 nights at seeds 101 and 202, against the control's existing held-out series. The owner's rule was applied with the refined variety guard (`decision-freeform-rev.txt`).

| Venue        | freeform-rev s101 | s202  | control s101 | s202  | d_v        |
| ------------ | ----------------- | ----- | ------------ | ----- | ---------- |
| narrow (1)   | 0.181             | 0.222 | 0.174        | 0.222 | +0.003     |
| shifting (2) | 0.146             | 0.181 | 0.194        | 0.194 | -0.031     |
| mismatch (3) | 0.181             | 0.153 | 0.160        | 0.111 | +0.031     |
| low          | 0.174             | 0.125 | 0.250        | 0.174 | -0.062     |
| high         | 0.090             | 0.271 | 0.097        | 0.125 | **+0.069** |
| narrow (6)   | 0.146             | 0.153 | 0.160        | 0.132 | +0.003     |
| shifting (7) | 0.139             | 0.174 | 0.118        | 0.215 | -0.010     |
| mismatch (8) | 0.160             | 0.125 | 0.215        | 0.083 | -0.007     |

- **Combined gain:** G = +0.000 off-target, SE = 0.014 (each venue counted once), G/SE = 0.03.
- **Control spread:** S = 0.057. The high venue is worse by 0.069, which is more than S.
- **Guard breaks over 48 nights:** variety 0, forbidden 0, carried 0, foreign 0.
- **Verdict:** KEEP current block. There is no gain, and one venue is worse by more than the control's spread.

Note: under the refined guard, beliefs-rev has 0 held-out guard breaks, so the same rule now gives ADOPT for it (G = +0.013, SE 0.006, 2.01 SE; `decision-beliefs-rev-refined-guard.txt`). It is not adopted here, because the owner asked only for the freeform-rev test.

## beliefs-fix held-out (owner's request, 2026-11-23), rule set before any run

beliefs-fix is beliefs-rev with C3's fix: one difficulty line per genre, and profile.md kept short (`candidates/beliefs-fix.md`). It is in `SYSTEM.md` while it is measured. It runs on 8 held-out venues × 3 nights at seeds 101 and 202, as new series against the control's existing held-out series, with the refined variety guard.

**Adoption rule:** G > 2·SE with each venue counted once, no venue with d_v > S (the control's seed-to-seed spread), and no guard broken. Otherwise the current block goes back. Nothing is deployed either way.

### beliefs-fix held-out result (2026-11-23)

| Venue        | beliefs-fix s101 | s202  | control s101 | s202  | d_v        |
| ------------ | ---------------- | ----- | ------------ | ----- | ---------- |
| narrow (1)   | 0.125            | 0.215 | 0.174        | 0.222 | -0.028     |
| shifting (2) | 0.188            | 0.132 | 0.194        | 0.194 | -0.035     |
| mismatch (3) | 0.146            | 0.139 | 0.160        | 0.111 | +0.007     |
| low          | 0.181            | 0.097 | 0.250        | 0.174 | -0.073     |
| high         | 0.188            | 0.160 | 0.097        | 0.125 | **+0.062** |
| narrow (6)   | 0.146            | 0.139 | 0.160        | 0.132 | -0.003     |
| shifting (7) | 0.132            | 0.174 | 0.118        | 0.215 | -0.014     |
| mismatch (8) | 0.215            | 0.076 | 0.215        | 0.083 | -0.003     |

- **Combined gain:** G = +0.011 off-target. Counting each venue once, SE = 0.014 (0.79 SE). Counting each of the 16 runs, G = +0.011 ± 0.011 (1.0 SE).
- **Control spread:** S = 0.057. The high venue is worse by 0.062, which is more than S.
- **Guard breaks, beliefs-fix (48 nights):** variety 1 (shifting (2), seed 202, night 2: film/film/science; film was named liked and science was loved on night 1), forbidden 0, carried 0, foreign 0. Control (48 nights): 0 of each.
- **Verdict:** fails all three conditions, so **KEEP current block**. `SYSTEM.md` is restored to the original memory block. C1–C3 were not rerun, because nothing was adopted. Nothing is deployed.

C3's fix (one difficulty line per genre, short profile) cost the gain beliefs-rev had shown (+0.013 at 2.01 SE on its own runs, without the fix). On the new runs the gain is +0.011 at 0.79 SE, within noise.

## C1–C3 on the kept (original) memory block, 2026-11-23

- **First run, on the instructions as they were:** C1 and C3 passed. C2 fetched one round twice, using up eight unread questions at the venue.
- **Fix:** in the night instructions only, decide a round's level before fetching, then fetch once. The memory section is unchanged.
- **Rerun:** C1, C2 and C3 all pass. See `case-results/current/` and `docs/DESIGN.md` Part B.
- **Held-out confirmation:** any future change to the memory section needs held-out confirmation under the owner's rule again.
