#!/usr/bin/env python3
"""Memory-search series runner for trivia-host (improve-memory m1).

  runner.py prep   <series-dir> <candidate> <venue> <seed> <n>   write brief-<n>.md (night 1 starts the world)
  runner.py finish <series-dir> <n>                              snapshot memories and this night's calls
  runner.py score  <series-dir>                                  print the series' scores
"""
import json, os, shutil, subprocess, sys

M = os.path.dirname(os.path.abspath(__file__))
FAKES = os.path.normpath(os.path.join(M, "..", "..", "fakes"))
SIM = f"{FAKES}/sim"
CLOCK = "2026-11-20T09:00:00Z"

TOOLS = """- trivia-bank start_night '{}'  (once, before the first round; returns tonight's week number)
- trivia-bank register_teams '{"names":["...", "..."]}'
- trivia-bank next_questions '{"count":8,"genre":"<music|film|sport|science|history|geography>","region":"<global|au|uk|us>","difficulty":<1-5>}'  (genre, region and difficulty are optional filters)
- trivia-bank submit_round '{"answers":[{"question_id":"...","team":"...","answer":"..."}, ...]}'  (every team's answer to every question in the round, in one call)
- trivia-bank round_summary '{}' or '{"week":<n>}'
- trivia-bank scoreboard '{"scope":"tonight"}' or '{"scope":"season"}'"""


def sim(*args):
    r = subprocess.run([SIM, *args], capture_output=True, text=True)
    if r.returncode not in (0, 1):
        sys.exit(f"sim failed: {r.stderr}")
    return r.stdout.strip()


def memory_view(mem):
    files = sorted(os.path.relpath(os.path.join(d, f), mem) for d, _, fs in os.walk(mem) for f in fs)
    if not files:
        return "empty"
    out = ["It holds:"]
    for f in files:
        out.append(f"\n--- memories/{f} ---\n" + open(os.path.join(mem, f)).read())
    return "\n".join(out)


def prep(series, candidate, venue, seed, n, preload=None):
    series = os.path.abspath(series)
    n = int(n)
    mem = os.path.join(series, "memories")
    if n == 1:
        if os.path.exists(series):
            shutil.rmtree(series)
        os.makedirs(mem)
        if preload:
            shutil.copytree(preload, mem, dirs_exist_ok=True)
        opening = sim("call", series, "subject", "say", '{"text":""}', "--scenario", venue, "--seed", str(seed), "--clock", CLOCK)
    else:
        opening = sim("call", series, "subject", "say", '{"text":""}')
    # A short path and a ready-made command, so the host never types the long series path.
    short = os.path.join("/tmp/m1", os.path.basename(series))
    os.makedirs("/tmp/m1", exist_ok=True)
    if os.path.islink(short) and os.path.realpath(short) != series:
        os.remove(short)
    if not os.path.islink(short):
        os.symlink(series, short)
    tool = os.path.join(series, "tool")
    open(tool, "w").write(f'#!/bin/sh\nexec "{SIM}" call "{series}" "$@"\n')
    os.chmod(tool, 0o755)
    calls = os.path.join(series, "calls.jsonl")
    open(os.path.join(series, f"calls-start-{n}"), "w").write(str(sum(1 for _ in open(calls)) if os.path.exists(calls) else 0))
    prompt = open(os.path.join(M, "candidates", candidate, "SYSTEM.md")).read()
    brief = f"""You are the agent below, in conversation {n} with the trivia master of this venue. Act only through the commands here; read and write only the memory folder.

## Your instructions

{prompt}

## Your memory

Folder: {short}/memories/. Wherever your instructions say `memories/`, they mean this folder. {memory_view(mem)}

## Tools

Each tool is one shell command that prints its answer:
{short}/tool <fake-id> <tool> '<arguments as JSON>'
Available:
{TOOLS}

## The conversation

Speak to the trivia master with:
{short}/tool subject say '{{"text":"<your message>"}}'
Use these exact command paths, copied character for character. Everything you would say in the chat goes through that command, one message per call, written exactly as you would send it. Wrap the JSON in single quotes, and never put a single quote inside it: write an apostrophe as ’ instead. Build every argument inline; never write a file anywhere but the memory folder.
It opened with: "{opening}". Keep going until it ends the conversation, do what your instructions say to do before finishing, then reply "done".
"""
    path = os.path.join(series, f"brief-{n}.md")
    open(path, "w").write(brief)
    print(path)


def finish(series, n):
    series = os.path.abspath(series)
    n = int(n)
    mem = os.path.join(series, "memories")
    dst = os.path.join(series, f"memory-after-{n}")
    if os.path.exists(dst):
        shutil.rmtree(dst)
    shutil.copytree(mem, dst)
    start = int(open(os.path.join(series, f"calls-start-{n}")).read())
    lines = open(os.path.join(series, "calls.jsonl")).read().splitlines()[start:]
    open(os.path.join(series, f"trajectory-{n}.jsonl"), "w").write("\n".join(lines) + "\n")
    print(f"night {n}: {len(lines)} calls")


def score(series):
    series = os.path.abspath(series)
    r = subprocess.run(["node", f"{FAKES}/world/score-series.ts", series], capture_output=True, text=True, cwd=FAKES)
    print(r.stdout or r.stderr)


if __name__ == "__main__":
    cmd, *rest = sys.argv[1:]
    {"prep": prep, "finish": finish, "score": score}[cmd](*rest)
