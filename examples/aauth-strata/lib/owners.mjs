/**
 * Alder Court's Person Server, built on @introspection-sdk/person-server
 * (ALL DATA IS FICTIONAL). It speaks for the occupants of each unit. Who
 * decides is the owners corporation's rule, set in the directory and the
 * approval hook:
 *
 * - a repair (a mission) goes to the committee chair, who sets its budget;
 * - a work order within that budget is issued with no one asked; one over it
 *   goes back to the chair;
 * - a special levy is priced in the levy unit, which no repair budget carries,
 *   so it always becomes an owners' ballot: every lot votes, and the ballot is
 *   decided at close (Owners Corporations Act 2006 (Vic) s86: a majority of
 *   the votes returned, and returns from at least half the lots);
 * - the occupant who reported the repair signs off its completion.
 *
 * Votes come only through each lot's own code, never from the agent.
 */
import { randomInt, randomUUID } from "node:crypto";

import { createPersonServer, problem } from "@introspection-sdk/person-server";

import { lots } from "./world.mjs";
import { LEVY_UNIT } from "./works.mjs";

const CHAIR = { id: "chair", name: "Committee chair, Lot 19" };
const OWNERS = { id: "owners", name: "Alder Court owners corporation" };
const occupant = (lot) => ({
  id: `unit-${lot}`,
  name: `Occupant of Unit ${lot}`,
  lot,
});

/** Status of a closed ballot, by s86: a majority of counted votes, with returns from half the lots. */
export function tally(ballot) {
  const returned = ballot.votes.size;
  let yes = 0,
    no = 0;
  for (const [lot, choice] of ballot.votes) {
    if (lots.find((l) => l.lot === lot)?.in_arrears) continue;
    if (choice === "for") yes++;
    else if (choice === "against") no++;
  }
  const quorum = Math.ceil(lots.length / 2);
  const status = !ballot.closed
    ? "open"
    : returned < quorum
      ? "failed_no_quorum"
      : yes > no
        ? "carried"
        : "defeated";
  return { returned, quorum, for: yes, against: no, status };
}

export async function createOwners({
  issuer,
  trustedAgentProviders,
  signingKey,
  adminToken,
  retryAfterSeconds,
  onEvent = () => {},
}) {
  const ballots = new Map();
  /** Approvals waiting on one person: the chair, or the occupant signing off. */
  const waiting = new Map();
  let ps;

  async function onApproval(approval) {
    if (
      approval.kind === "auth_token" &&
      approval.budget?.unit === LEVY_UNIT.unit
    ) {
      const ballot = {
        id: `B-${randomUUID().slice(0, 8)}`,
        approval_id: approval.id,
        summary: approval.summary ?? approval.description,
        closed: false,
        votes: new Map(),
        codes: new Map(
          lots.map(({ lot }) => [lot, String(randomInt(100000, 1000000))]),
        ),
      };
      ballots.set(ballot.id, ballot);
      // Each lot's ballot email carries its own code; printed here as the demo's outbox.
      for (const [lot, code] of ballot.codes)
        console.log(
          `ballot ${ballot.id} email to Unit ${lot}: your code ${code}`,
        );
      onEvent("owners.ballot_opened", {
        id: ballot.id,
        summary: ballot.summary,
      });
      return;
    }
    waiting.set(approval.id, approval);
    onEvent("owners.approval", {
      id: approval.id,
      kind: approval.kind,
      approver: approval.approver.name,
      summary: approval.summary ?? approval.description,
    });
  }

  ps = await createPersonServer({
    issuer,
    trustedAgentProviders,
    signingKey,
    adminToken,
    ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    directory: {
      person: (hint) => {
        const lot = Number(/^unit:(\d+)$/.exec(hint)?.[1]);
        return lots.some((l) => l.lot === lot) ? occupant(lot) : undefined;
      },
      approver: (kind, person) =>
        kind === "mission" ? CHAIR : kind === "completion" ? person : OWNERS,
    },
    onApproval,
  });

  async function close(id) {
    const ballot = ballots.get(id);
    if (!ballot || ballot.closed) return undefined;
    ballot.closed = true;
    const result = tally(ballot);
    await ps.decide(ballot.approval_id, {
      status: result.status === "carried" ? "approved" : "denied",
      decided_by: `owners' ballot ${id}`,
    });
    onEvent("owners.ballot_closed", { id, ...result });
    return result;
  }

  function vote(id, lot, code, choice) {
    const ballot = ballots.get(id);
    if (!ballot || ballot.closed) return { error: "no open ballot" };
    if (ballot.codes.get(lot) !== String(code))
      return { error: "wrong code for that lot" };
    if (!["for", "against", "abstain"].includes(choice))
      return { error: "choice is for | against | abstain" };
    if (ballot.votes.has(lot))
      return { error: `Unit ${lot} has already voted` };
    ballot.votes.set(lot, choice);
    onEvent("owners.vote", { id, lot, choice });
    return view(ballot);
  }

  const view = (b) => ({
    id: b.id,
    summary: b.summary,
    closed: b.closed,
    voted: [...b.votes.keys()],
    ...tally(b),
  });
  const isAdmin = (request) =>
    adminToken &&
    request.headers.get("authorization") === `Bearer ${adminToken}`;

  return {
    ps,
    ballots,
    waiting,
    close,
    /** A person's decision on an approval waiting on them (the chair's, or an occupant's sign-off). */
    async decide(id, decision) {
      waiting.delete(id);
      return ps.decide(id, decision);
    },
    vote,
    /** The Person Server's AAuth routes, plus the owners' ballot routes under /owners. */
    async handle(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/owners/ballots" && request.method === "GET")
        return Response.json([...ballots.values()].map(view));
      const m = /^\/owners\/ballots\/([^/]+)\/(votes|close)$/.exec(pathname);
      if (m && request.method === "POST") {
        if (m[2] === "close") {
          if (!isAdmin(request))
            return problem(401, "unauthorized", "the manager closes a ballot");
          const result = await close(m[1]);
          return result
            ? Response.json(result)
            : problem(404, "not_found", "no open ballot");
        }
        const { lot, code, choice } = await request.json().catch(() => ({}));
        const out = vote(m[1], Number(lot), code, choice);
        return out.error
          ? problem(409, "vote_refused", out.error)
          : Response.json(out);
      }
      return ps.handle(request);
    },
  };
}
