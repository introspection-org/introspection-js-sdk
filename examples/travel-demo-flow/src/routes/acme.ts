/**
 * Acme's Person Server: the handlers each example's `app/acme/**` routes
 * export. Every request is recorded for the demo page.
 */
import { decide } from "../acme/approvals";
import { handle, personServer } from "../acme/person-server";
import { AAuthError, respond } from "../aauth";
import { recorded } from "../demo/wire";

export async function metadataGET() {
  return Response.json((await personServer()).metadata());
}

export async function jwksGET() {
  return Response.json((await personServer()).jwks());
}

/** The approver's answer from Acme's page, proven by the code Acme emailed. */
export async function approvalPOST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return recorded("Acme", request, () =>
    respond(async () => {
      const body = await request.json().catch(() => ({}));
      const verdict = body.verdict;
      if (
        typeof body.code !== "string" ||
        (verdict !== "approve" && verdict !== "decline")
      )
        throw new AAuthError(
          400,
          "invalid_request",
          "a code and a verdict of approve or decline are required",
        );
      const budget =
        body.budget == null ? undefined : Math.round(Number(body.budget) * 100);
      return Response.json(await decide(id, body.code, verdict, budget));
    }),
  );
}

/** The agent proposes a trip; the traveller's manager approves it once. */
export async function missionPOST(request: Request) {
  return recorded("Acme", request, () => handle(request, "/ps/mission"));
}

/** An update to the trip, or the agent's proposal that it is done. */
export async function missionUpdatePOST(
  request: Request,
  { params }: { params: Promise<{ s256: string }> },
) {
  const { s256 } = await params;
  return recorded("Acme", request, () =>
    handle(request, `/ps/mission/${s256}`),
  );
}

/**
 * The agent polls a pending approval here with a signed GET, or withdraws it
 * with a DELETE. The Person Server names the tenant in the URL
 * (`/ps/pending/{tenant}/{id}`), so this takes every segment after `pending`.
 */
export async function pending(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const rest = path.map(encodeURIComponent).join("/");
  return recorded("Acme", request, () =>
    handle(request, `/ps/pending/${rest}`),
  );
}

/** Who the agent acts for, at one resource, under its mission. */
export async function personTokenPOST(request: Request) {
  return recorded("Acme", request, () => handle(request, "/ps/person-token"));
}

/** A resource token in, an auth token (or a pending approval) out. */
export async function tokenPOST(request: Request) {
  return recorded("Acme", request, () => handle(request, "/ps/token"));
}
