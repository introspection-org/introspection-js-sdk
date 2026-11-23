#!/usr/bin/env python3
"""Scorecard over finished series: python3 scorecard.py [prefix-filter]"""
import glob, json, os, subprocess, sys, statistics as st
M = os.path.dirname(os.path.abspath(__file__))
rows = {}
for d in sorted(glob.glob(f"{M}/series/*")):
    name = os.path.basename(d)
    if len(sys.argv) > 1 and not any(name.startswith(p) for p in sys.argv[1:]): continue
    if not os.path.exists(f"{d}/memory-after-1"): continue
    out = subprocess.run(["python3", f"{M}/runner.py", "score", d], capture_output=True, text=True).stdout
    try: s = json.loads(out)
    except Exception: continue
    cand, venue, rep = name.split(".")
    ns = [n for n in s["nights"] if n["night"] >= 2]
    done = len([n for n in s["nights"] if os.path.exists(f"{d}/memory-after-{n['night']}")])
    cl = [n["closeness"] for n in ns if n["closeness"] is not None]
    en = [n["enjoyed"] for n in ns if n["enjoyed"] is not None]
    rows.setdefault(cand, []).append(dict(venue=venue, rep=rep, nights=done,
        off=st.mean(cl) if cl else None, enjoyed=st.mean(en) if en else None,
        foreign=sum(n["foreign"] for n in ns),
        forbidden=sum(1 for n in s["nights"] if n["memoryForbidden"]),
        carried=sum(1 for n in s["nights"] if n["memoryCarriesRequest"] or n["requestCarried"])))
f = lambda x: "  -  " if x is None else f"{x:.3f}"
for cand, rs in rows.items():
    print(f"\n{cand}")
    for r in rs: print(f"  {r['venue']:18} {r['rep']} nights={r['nights']} off-target={f(r['off'])} enjoyed={f(r['enjoyed'])} foreign={r['foreign']} forbidden-nights={r['forbidden']} carried={r['carried']}")
    offs = [r["off"] for r in rs if r["off"] is not None]; ens = [r["enjoyed"] for r in rs if r["enjoyed"] is not None]
    if offs: print(f"  MEAN off-target={st.mean(offs):.3f} (worst {max(offs):.3f})  enjoyed={st.mean(ens):.3f} (worst {min(ens):.3f})")
