/**
 * Flight Sector's booking provider, an AAuth resource: the handlers each
 * example's `app/booking/**` routes export. Every request is recorded for the
 * demo page.
 */
import { NextResponse } from "next/server";

import { respond } from "../aauth";
import {
  bookingResource,
  cancel,
  quoteFlight,
  reservations,
  reserve,
  resourceMetadata,
  search,
  serveProposal,
} from "../booking";
import { recorded } from "../demo/wire";
import { handle, readJson } from "../http";

type Key = { params: Promise<{ key: string }> };

export async function metadataGET() {
  return Response.json(await resourceMetadata());
}

export async function jwksGET() {
  return NextResponse.json((await bookingResource()).jwks());
}

/** A booking proposal, served to the Person Server it was published for. */
export async function proposalGET(request: Request, { params }: Key) {
  const { key } = await params;
  return recorded("Booking provider", request, () =>
    respond(() => serveProposal(request, key)),
  );
}

export async function auditGET() {
  return handle(async () => ({ reservations }));
}

export async function cancelPOST(request: Request) {
  return recorded("Booking provider", request, () =>
    respond(() => cancel(request)),
  );
}

export async function quotePOST(request: Request) {
  return recorded("Booking provider", request, () =>
    handle(async () => quoteFlight(await readJson(request))),
  );
}

export async function reservePOST(request: Request) {
  return recorded("Booking provider", request, () =>
    respond(() => reserve(request)),
  );
}

export async function searchPOST(request: Request) {
  return recorded("Booking provider", request, () =>
    handle(async () => search(await readJson(request))),
  );
}
