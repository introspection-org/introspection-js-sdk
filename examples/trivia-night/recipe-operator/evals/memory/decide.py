#!/usr/bin/env python3
"""Pre-registered second-seed decision (RESULTS.md). Prints per-venue table, G, SE, S and the verdict."""
import json, os, subprocess, sys, statistics as st
M = os.path.dirname(os.path.abspath(__file__))
CAND = sys.argv[1] if len(sys.argv) > 1 else "beliefs-rev"
V = [f"held-{i}-{k}" for i, k in enumerate(["narrow","shifting","mismatch","low","high","narrow","shifting","mismatch"], 1)]
def off(c, v, r):
    d = f"{M}/series/{c}.{v}.r{r}"
    s = json.loads(subprocess.run(["python3", f"{M}/runner.py", "score", d], capture_output=True, text=True).stdout)
    ns = [n for n in s["nights"] if n["night"] >= 2]
    assert len(s["nights"]) == 3 and all(len([x for x in n["rounds"] if x["rate"] is not None]) >= 3 for n in s["nights"]), f"incomplete: {d}"
    breaks = sum(1 for n in s["nights"] if n["memoryForbidden"] or n["memoryCarriesRequest"] or n["requestCarried"] or n["foreign"] or n.get("varietyBroken"))
    return st.mean(n["closeness"] for n in ns), breaks
rows, pairs, spreads = [], [], []
for v in V:
    b1, bb1 = off(CAND, v, 1); b2, bb2 = off(CAND, v, 2)
    c1, cb1 = off("control", v, 1); c2, cb2 = off("control", v, 2)
    d = ((b1 - c1) + (b2 - c2)) / 2
    rows.append((v, b1, b2, c1, c2, d, bb1 + bb2, cb1 + cb2)); pairs += [b1 - c1, b2 - c2]; spreads.append(abs(c1 - c2))
print(f"{'venue':18} {'b s101':>7} {'b s202':>7} {'c s101':>7} {'c s202':>7} {'d_v':>7}  breaks b/c")
for v, b1, b2, c1, c2, d, bb, cb in rows: print(f"{v:18} {b1:7.3f} {b2:7.3f} {c1:7.3f} {c2:7.3f} {d:+7.3f}  {bb}/{cb}")
dv = [r[5] for r in rows]
G = -st.mean(dv); SE = st.stdev(dv) / len(dv) ** 0.5; S = st.mean(spreads)
G16 = -st.mean(pairs); SE16 = st.stdev(pairs) / len(pairs) ** 0.5
worse = [(r[0], round(r[5], 3)) for r in rows if r[5] > S]
print(f"\nG = {G:+.3f}, SE (venue unit) = {SE:.3f}, G/SE = {G/SE:.2f}   [16 pairs: {G16:+.3f} ± {SE16:.3f}]")
print(f"S (control seed-to-seed spread) = {S:.3f}; venues with d_v > S: {worse or 'none'}")
cand_breaks = sum(r[6] for r in rows)
print(f"{CAND} guard breaks across held-out: {cand_breaks}")
ok = G > 2 * SE and not worse and cand_breaks == 0
print("VERDICT:", f"ADOPT {CAND}" if ok else "KEEP current block")
