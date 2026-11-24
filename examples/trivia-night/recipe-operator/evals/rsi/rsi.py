#!/usr/bin/env python3
"""A pre-specified self-improvement search over the trivia host's memory block.

Starts from the original Recipe (an empty memory block). Each generation, a fixed
proposer prompt (Opus on the Pi subscription, no tools) reads the parent block and
its evidence on the 11 development pubs and writes CHILDREN new blocks; each child
plays every development pub's two nights (run-series.sh, hosted arm) and is scored
by the platform's own verifier. The best child by mean good_rounds (tie-break
favourite_genre) becomes the next parent if it beats the parent. After the last
generation one merge child combines the best block per capability (genre targeting:
favourite_genre; pitch: in_band; hygiene: notes_kept), PrisMem-style. The final
pick is the best block seen. Nothing here reads a held-out pub.
"""
import concurrent.futures as cf
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

X = Path(__file__).resolve().parent
CONTROL = X / "candidates" / "control"
PUBS = ["sydney", "manchester", "chicago", "leeds", "melbourne", "boston",
        "bristol", "brisbane", "seattle", "glasgow", "perth"]
GENERATIONS = 3
CHILDREN = 3
PARALLEL = 4
PROPOSER = "anthropic/claude-opus-5-5"
START, END = "<!-- memory:start -->", "<!-- memory:end -->"
TEAM_WORDS = None  # filled from the tasks' expected.json
TASKS = Path.home() / "introspection/introspection-js-sdk/examples/trivia-night/recipe-operator/evals/harbor"
LOG = X / "rsi.log"


def log(msg):
    print(msg, flush=True)
    with open(LOG, "a") as f:
        f.write(msg + "\n")


def control_system():
    return (CONTROL / "SYSTEM.md").read_text()


def with_block(block):
    s = control_system()
    head, rest = s.split(START, 1)
    _, tail = rest.split(END, 1)
    return f"{head}{START}\n{block.strip()}\n\n{END}{tail}" if block.strip() else f"{head}{START}\n\n{END}{tail}"


def block_of(system):
    return system.split(START, 1)[1].split(END, 1)[0].strip()


def team_words():
    words = set()
    for p in PUBS:
        for n in (1, 2):
            e = json.loads((TASKS / f"night{n}-{p}/tests/expected.json").read_text())
            for t in e.get("teams", []) + e.get("night1_teams", []):
                words.add(re.sub(r"^the\s+", "", t, flags=re.I).lower())
    return words


def guard(block):
    low = block.lower()
    named = [t for t in TEAM_WORDS if t in low]
    if named:
        return f"names teams: {named}"
    if len(block) > 6000:
        return "longer than 6000 characters"
    return None


def make(name, block):
    d = X / "candidates" / name
    if d.exists():
        shutil.rmtree(d)
    shutil.copytree(CONTROL, d, symlinks=True)
    (d / "SYSTEM.md").write_text(with_block(block))
    # Only the marked block may differ from the control.
    a, b = control_system(), (d / "SYSTEM.md").read_text()
    assert a.split(START)[0] == b.split(START)[0] and a.split(END)[1] == b.split(END)[1]
    (d / "BLOCK.md").write_text(block)
    return d, hashlib.sha256(block.encode()).hexdigest()[:12]


def play(cand, pub, evidence):
    out = evidence / pub / "hosted" / "measures.json"
    if out.exists():
        return pub, json.loads(out.read_text())
    for attempt in (1, 2):
        r = subprocess.run([str(X / "run-series.sh"), str(cand), pub, "hosted", str(evidence)],
                           capture_output=True, text=True)
        if out.exists():
            return pub, json.loads(out.read_text())
        log(f"  {cand.name} {pub} attempt {attempt} failed: {(r.stdout + r.stderr)[-400:]}")
        shutil.rmtree(evidence / pub, ignore_errors=True)
    return pub, None


def score(name, block):
    cand, digest = make(name, block)
    evidence = X / "evidence" / name
    with cf.ThreadPoolExecutor(PARALLEL) as pool:
        results = dict(pool.map(lambda p: play(cand, p, evidence), PUBS))
    done = {p: m for p, m in results.items() if m}
    mean = lambda k: sum(m.get(k, 0) for m in done.values()) / max(len(done), 1)
    summary = {
        "name": name, "digest": digest, "pubs": len(done),
        "good_rounds": round(mean("good_rounds"), 4),
        "favourite_genre": round(mean("favourite_genre"), 4),
        "in_band": round(mean("in_band"), 4),
        "pitch_miss": round(mean("pitch_miss"), 4),
        "notes_kept": round(mean("notes_kept"), 4),
        "per_pub": {p: {k: m.get(k) for k in ("good_rounds", "favourite_genre", "in_band", "pitch_miss", "notes_kept")} for p, m in done.items()},
    }
    (evidence / "summary.json").write_text(json.dumps(summary, indent=1))
    log(f"{name} [{digest}] pubs={len(done)} good_rounds={summary['good_rounds']} favourite_genre={summary['favourite_genre']} in_band={summary['in_band']} notes_kept={summary['notes_kept']}")
    return summary


def digest_evidence(name):
    ev = X / "evidence" / name
    parts = []
    for p in PUBS:
        d = ev / p / "hosted"
        if not (d / "measures.json").exists():
            continue
        m = json.loads((d / "measures.json").read_text())
        rep = {}
        try:
            rep = json.loads((d / "score" / "report.json").read_text())
        except Exception:
            pass
        e = json.loads((TASKS / f"night2-{p}/tests/expected.json").read_text())
        rounds = "; ".join(f"{f['genre']} d{f['difficulty']} {('%.0f%%' % (100*f['correct_rate'])) if f.get('correct_rate') is not None else '-'}" for f in rep.get("fetches", []))
        notes1 = (d / "night1-MEMORY.md").read_text().strip() if (d / "night1-MEMORY.md").exists() else "(none written)"
        parts.append(
            f"### Pub: {p}\n"
            f"Crowd's true favourite genres (hidden from the host): {', '.join(e['liked'])}; disliked: {', '.join(e.get('disliked', []))}; difficulty that suits them: {e.get('target_difficulty')}\n"
            f"Night-2 rounds (genre, difficulty, share right): {rounds}\n"
            f"Night-2 scores: good_rounds {m.get('good_rounds')}, favourite_genre {m.get('favourite_genre')}, in_band {m.get('in_band')}, pitch_miss {m.get('pitch_miss')}, notes_kept {m.get('notes_kept')}\n"
            f"Notes the host left after night 1:\n```\n{notes1[:1500]}\n```\n")
    return "\n".join(parts)


PROPOSER_PROMPT = """You improve one section of a pub-quiz host agent's instructions: its MEMORY BLOCK, the text between the memory markers in its system prompt. Each pub is a separate customer; the host keeps notes for a pub in `memories/MEMORY.md` between that pub's weekly nights. Only this block may change; the rest of the system prompt is fixed and shown below.

How a night is judged (night 2, after the host has played night 1 at the same pub): a round is GOOD when it is in a genre the crowd loves AND between 55% and 75% of the crowd's answers are right. The objective is the share of good rounds on night 2. The crowd's favourite genres are never told to the host on night 2; it can only know them from what it learned on night 1 and wrote in its notes. About 80% of teams return. Questions never repeat. On night 1 the trivia master may hint at one favourite genre.

Hard rules for any block you write: never tell the host to write team names, scores, standings or any question or answer into the notes; a one-night request is never a lasting preference; keep the block under about 4000 characters; it must work for a pub the host has never seen (no notes yet) as well as a returning one.

The fixed system prompt, with the current block in place:
```
{system}
```

The parent block's evidence, one development pub at a time (the hidden favourites are shown to YOU for diagnosis only; the host never sees them):
{evidence}

Parent scores (means over pubs): {scores}
{history}
Diagnose what in the parent block causes night 2 to miss good rounds (wrong genres, poor pitch, notes that lose information, notes that are too vague to act on, night 1 not exploring enough to learn the tastes, etc). Then write {k} DIFFERENT improved memory blocks, each testing a distinct idea. Output each block between lines `=== BLOCK n ===` and `=== END ===`, with a one-line `Idea:` before each. Output nothing else after the last block."""

MERGE_PROMPT = """You merge pub-quiz host memory blocks. Each block below was the best of a search at one capability. Write ONE memory block that keeps what made each best at its capability, without contradictions, under about 4000 characters, following the same hard rules (never team names, scores, standings, questions or answers in the notes; a one-night request is never lasting). Output it between `=== BLOCK 1 ===` and `=== END ===` with a one-line `Idea:` before it.

{blocks}"""


def propose(prompt, k, tag):
    out = X / "proposals" / f"{tag}.txt"
    out.parent.mkdir(exist_ok=True)
    env = {k_: v for k_, v in os.environ.items() if k_ not in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN")}
    r = subprocess.run(["pi", "-p", "--no-tools", "--model", PROPOSER, "--", prompt],
                       capture_output=True, text=True, env=env, timeout=1800)
    out.write_text(r.stdout + ("\n\nSTDERR:\n" + r.stderr if r.returncode else ""))
    blocks = re.findall(r"=== BLOCK \d+ ===\s*\n(.*?)\n=== END ===", r.stdout, re.S)
    return [b.strip() for b in blocks][:k]


def main():
    global TEAM_WORDS
    TEAM_WORDS = team_words()
    seen = []
    original = score("g0-original", "")
    seen.append(("", original))
    parent_block, parent = "", original
    history = ""
    for g in range(1, GENERATIONS + 1):
        prompt = PROPOSER_PROMPT.format(
            system=with_block(parent_block), evidence=digest_evidence(parent["name"]),
            scores=json.dumps({k: parent[k] for k in ("good_rounds", "favourite_genre", "in_band", "pitch_miss", "notes_kept")}),
            history=history, k=CHILDREN)
        children = propose(prompt, CHILDREN, f"g{g}")
        log(f"generation {g}: {len(children)} proposals")
        best = None
        for i, block in enumerate(children, 1):
            bad = guard(block)
            if bad:
                log(f"  g{g}c{i} rejected: {bad}")
                continue
            s = score(f"g{g}c{i}", block)
            seen.append((block, s))
            if best is None or (s["good_rounds"], s["favourite_genre"]) > (best[1]["good_rounds"], best[1]["favourite_genre"]):
                best = (block, s)
        history += f"\nGeneration {g} children of the parent scored: " + "; ".join(f"{s['name']} good_rounds {s['good_rounds']}" for _, s in seen if s["name"].startswith(f"g{g}c")) + "\n"
        if best and (best[1]["good_rounds"], best[1]["favourite_genre"]) > (parent["good_rounds"], parent["favourite_genre"]):
            parent_block, parent = best
            log(f"generation {g}: new parent {parent['name']} good_rounds={parent['good_rounds']}")
        else:
            log(f"generation {g}: parent kept ({parent['name']})")
    # Merge the best block per capability.
    caps = {"genre targeting (favourite_genre)": "favourite_genre", "pitch (in_band)": "in_band", "note hygiene (notes_kept)": "notes_kept"}
    picks = {}
    for label, key in caps.items():
        cands = [(b, s) for b, s in seen if b]
        if cands:
            picks[label] = max(cands, key=lambda bs: (bs[1][key], bs[1]["good_rounds"]))
    distinct = {s["name"]: (b, s) for b, s in picks.values()}
    if len(distinct) > 1:
        text = "\n\n".join(f"Best at {label} ({s['name']}, {caps[label]} {s[caps[label]]}, good_rounds {s['good_rounds']}):\n```\n{b}\n```" for label, (b, s) in picks.items())
        merged = propose(MERGE_PROMPT.format(blocks=text), 1, "merge")
        if merged and not guard(merged[0]):
            s = score("merge", merged[0])
            seen.append((merged[0], s))
    final = max([bs for bs in seen if bs[0]], key=lambda bs: (bs[1]["good_rounds"], bs[1]["favourite_genre"]))
    (X / "FINAL_BLOCK.md").write_text(final[0])
    log(f"FINAL {final[1]['name']} good_rounds={final[1]['good_rounds']} (original {original['good_rounds']})")
    (X / "search.json").write_text(json.dumps([s for _, s in seen], indent=1))


if __name__ == "__main__":
    main()
