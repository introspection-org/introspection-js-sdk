#!/usr/bin/env python3
"""Revision round 2 selection: a revision qualifies if it breaks no guard on the three training venues (seed 101)
and beats its parent's mean off-target by more than the control's training seed-to-seed spread."""
import json, os, subprocess, statistics as st
M = os.path.dirname(os.path.abspath(__file__))
V = ["au-film", "uk-sport", "us-science"]
def sc(c, v, r):
    s = json.loads(subprocess.run(["python3", f"{M}/runner.py", "score", f"{M}/series/{c}.{v}.r{r}"], capture_output=True, text=True).stdout)
    ns = [n for n in s["nights"] if n["night"] >= 2]
    breaks = sum(1 for n in s["nights"] if n["memoryForbidden"] or n["memoryCarriesRequest"] or n["requestCarried"] or n["foreign"] or n["varietyBroken"])
    assert len(s["nights"]) == 4, f"incomplete {c}.{v}"
    return st.mean(n["closeness"] for n in ns), breaks
S = st.mean(abs(sc("control", v, 1)[0] - sc("control", v, 2)[0]) for v in V)
print(f"control training seed-to-seed spread S = {S:.3f}")
best = None
for rev, parent in [("freeform-rev", "freeform"), ("beliefs-rev2", "beliefs")]:
    r = [sc(rev, v, 1) for v in V]; p = [sc(parent, v, 1) for v in V]
    gain = st.mean(x[0] for x in p) - st.mean(x[0] for x in r); br = sum(x[1] for x in r)
    ok = br == 0 and gain > S
    print(f"{rev:14} off {' '.join(f'{x[0]:.3f}' for x in r)} mean {st.mean(x[0] for x in r):.3f} | parent {parent} mean {st.mean(x[0] for x in p):.3f} | gain {gain:+.3f} | guard breaks {br} | {'QUALIFIES' if ok else 'does not qualify'}")
    if ok and (best is None or st.mean(x[0] for x in r) < best[1]): best = (rev, st.mean(x[0] for x in r))
print("SELECTED:", best[0] if best else "none")
