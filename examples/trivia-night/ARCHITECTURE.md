# How Trivia Night works

A trivia host (the agent) runs quiz nights at many venues and gets better at each one. Two stores hold what carries between nights, and they never overlap:

- **The question bank** holds facts: the questions, which ones each venue has heard, and how its teams answered. It is an MCP server, and it enforces its rules in code.
- **The host's memory** holds judgement: per venue, the few settings that change the next night's choices (region, liked genres, a level per genre). It is the agent's own folder for that venue, written by the agent under the rules in its memory block.

## The pieces

```mermaid
flowchart LR
  subgraph Platform["Introspection platform (or the in-session runner)"]
    Host["Trivia host agent<br/>SYSTEM.md with a memory block"]
    Mem[("Venue memory folder<br/>memory/&lt;lane&gt;/member:&lt;venue&gt;/<br/>MEMORY.md + notes")]
    Host -- "reads at the start, rewrites at the end" --> Mem
  end
  TM["Trivia master<br/>(a person at the venue,<br/>or the simulated room)"]
  subgraph Bank["Question bank: MCP server (lib/mcp.ts)"]
    Tools["next_questions · submit_round<br/>round_summary · scoreboard"]
    Facts[("Per venue: questions asked,<br/>answer sheets, team scores<br/>(lib/bank.ts, lib/scorer.ts, lib/state.ts)")]
    Id["Identity (lib/identity.ts):<br/>token sub = user:&lt;venue&gt;"]
    Tools --> Facts
    Id --> Facts
  end
  TM <-- "chat: plan, questions, answer sheets" --> Host
  Host -- "MCP tool calls + end-user token" --> Tools
```

- **No tool takes a venue.** The platform runs each venue's conversations as one end user (`--subject <venue>`) and sends a signed token naming it; `lib/identity.ts` verifies it and the bank keys everything by that venue. With no platform, a development header stands in.
- **Never repeating a question is the bank's job.** `next_questions` only returns questions that venue hasn't heard; when a genre, region and level runs dry it widens the filter (region to global, then difficulty by one step) and says so, never repeating. The host's memory is not allowed to keep questions, so it cannot get this wrong.
- **Team names and scores live in the bank**, because scoring needs them. The memory rules forbid keeping them in the notes.

## A night

```mermaid
sequenceDiagram
  participant TM as Trivia master
  participant H as Host
  participant M as Venue memory
  participant B as Question bank
  H->>M: read MEMORY.md and the venue's notes
  H->>TM: the plan (genres, starting level, why)
  loop each round
    H->>B: next_questions(genre, region, difficulty)
    B-->>H: questions this venue hasn't heard
    H->>TM: the questions, read out to the room
    TM-->>H: every team's answers
    H->>B: submit_round(answers)
    B-->>H: scores and correct answers
    H->>B: round_summary
    B-->>H: share right, by genre and difficulty
    H->>TM: scores; next round's level (one step at most) and why
  end
  H->>M: rewrite the notes: only what changes next week's choices
```

The rules the owner set: adapt between rounds, never inside one; one level at a time; say the plan at the start; a request for tonight is never a lasting preference; never keep team names, scores or the questions asked.

## How it is tested and improved

```mermaid
flowchart TB
  subgraph World["The simulated world (seeded)"]
    V["Venue profiles<br/>(lib/venues.ts): region, skill per genre,<br/>liked genres, teams; 8 held-out sampled from a fixed seed"]
    R["Reaction: chanceRight / teamAnswer<br/>difficulty vs skill, own-region bonus"]
    RM["Trivia master script<br/>(scripts/room-master.ts): opening, venue answers,<br/>the one-night request, answer sheets"]
    V --> R
  end
  subgraph Runner["In-session series runner"]
    C["Candidate = SYSTEM.md with one memory block"]
    S["Series = one venue's nights in order<br/>memory/ folder + bank state carried between nights"]
    N["Each night: a fresh subagent briefed with the candidate,<br/>calling tools through a shell bridge"]
    C --> S --> N
  end
  N -- "tool calls" --> B2["Question bank"]
  N -- "messages" --> RM
  RM -- "answer sheets drawn from" --> R
  B2 --> SC["Scorecard (scripts/scorecard.ts):<br/>pitch miss from the bank's state,<br/>guards from the memory snapshots"]
  SC --> MA["Meta agent revises the best blocks<br/>→ held-out venues pick among ties"]
```

- **Everything except the host is fixed and seeded**, so a comparison measures only the memory block. Two blocks that make the same calls get the same results to the question.
- **The supply is sized** (240 questions, or 2,102 with `TRIVIA_BANK=large`) so a venue's series never empties a cell; a bank that ran short decided an early result.
- **The scorecard reads the record, not the host's account of it:** pitch miss (points from 65% right, nights two onward), asked-for rounds, unfair questions, repeats, and whether the one-night request reached the notes.

With released tooling the same shape needs no hand-written harness: the bank and the trivia master are eval-simulate fakes in the Recipe's `fakes/`, and `introspection eval simulate call|state` carries their state across a series. The Operator's `improve-memory` step runs the whole loop; [WALKTHROUGH.md](./WALKTHROUGH.md) replays it from one prompt.
