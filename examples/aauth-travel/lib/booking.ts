/**
 * Flight Sector's booking provider, a native AAuth resource. Every offer
 * carries a quote this provider signs. Policy is not this provider's job: a
 * reservation needs a person token from the traveller's Person Server, then an
 * auth token from it for exactly this booking, which the provider describes in
 * a per-call R3 proposal only that Person Server may read.
 */
import "server-only";

import { randomUUID } from "node:crypto";

import {
  MemoryR3Store,
  type VerifiedToken,
  buildRequirementHeader,
  createResourceToken,
  publishProposal,
  serveR3Document,
  verifyProposalParameters,
} from "@aauth/resource";
import { type JWTPayload, createLocalJWKSet, jwtVerify } from "jose";

import {
  AAuthError,
  now,
  signatureError,
  verifyPresented,
  verifySignature,
} from "./aauth";
import { record } from "./events";
import { HttpError } from "./http";
import { AGENT_PROVIDERS, BOOKING_ISSUER, PERSON_SERVER_URL } from "./origins";
import { bookingSigner } from "./signing";
import { flights, hotels } from "./world";

const QUOTE_TTL_SECONDS = 30 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISSUER = BOOKING_ISSUER;
const SCOPE = "booking.reserve";
const RESERVE_URL = `${ISSUER}/v1/reserve`;
/** The R3 vocabulary this provider describes bookings in. */
const VOCABULARY = `${ISSUER}/r3/vocabulary`;
const OPERATION = { action: "reserve" };
// Person Servers whose people this provider serves. Fetching an issuer's keys
// is egress, so the list is closed.
const PERSON_SERVERS = (process.env.BOOKING_PERSON_SERVERS || PERSON_SERVER_URL)
  .split(",")
  .map((url) => url.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const r3 = ((
  globalThis as unknown as { __flightSectorR3?: MemoryR3Store }
).__flightSectorR3 ??= new MemoryR3Store());

// #region metadata
/** `/.well-known/aauth-resource.json`: how an agent plans its first call. */
export function resourceMetadata() {
  return {
    issuer: ISSUER,
    jwks_uri: `${ISSUER}/.well-known/jwks.json`,
    access_mode: "auth-token",
    name: "Flight Sector Booking",
    description:
      "Flights and hotels for company travel. Search is open; a reservation needs an auth token from the traveller's Person Server.",
    scope_descriptions: { [SCOPE]: "Reserve the quoted flight or hotel" },
    r3_vocabularies: [VOCABULARY],
    additional_signature_components: ["content-type", "content-digest"],
  };
}
// #endregion

const isDate = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

export interface Reservation {
  confirmation: string;
  offer_id: string;
  kind: string;
  total_cents: number;
  purpose: string;
  payer: string;
  ps: string;
  sub: string;
  mission_s256?: string;
  auth_token_jti: string;
  reserved_at: string;
}

const store = globalThis as unknown as {
  __flightSectorReservations?: Reservation[];
};
export const reservations = (store.__flightSectorReservations ??= []);

// #region quote
/** Sign an offer's facts. The quote is what the Person Server decides on. */
async function quote(offer: Record<string, unknown>) {
  const signer = await bookingSigner();
  const iat = Math.floor(Date.now() / 1000);
  const valid_until = iat + QUOTE_TTL_SECONDS;
  const quote = await signer.sign({ ...offer, iss: ISSUER, iat, valid_until });
  return { ...offer, valid_until, quote };
}
// #endregion

export async function search(body: Record<string, unknown>) {
  if (body.kind === "flight") {
    const { from, to, date, cabin } = body;
    if (!from || !to || !isDate(date)) {
      throw new HttpError(
        400,
        "flight search needs from, to and date (YYYY-MM-DD)",
      );
    }
    const offers = await Promise.all(
      flights
        .filter((f) => f.from === from && f.to === to)
        .flatMap((f) =>
          Object.entries(f.fares_cents)
            .filter(([fareCabin]) => !cabin || fareCabin === cabin)
            .map(([fareCabin, total]) =>
              quote({
                offer_id: `fl:${f.id}:${date}:${fareCabin}`,
                kind: "flight",
                carrier: f.carrier,
                flight: f.flight,
                from: f.from,
                to: f.to,
                dest: f.to,
                depart: `${date}T${f.depart_time}`,
                block_minutes: f.block_minutes,
                stops: f.stops,
                cabin: fareCabin,
                total_cents: total,
                currency: "USD",
              }),
            ),
        ),
    );
    record(
      "booking.searched",
      `${offers.length} flights ${from}→${to} on ${date}`,
      { kind: "flight", from, to, date },
    );
    return { offers };
  }
  if (body.kind === "hotel") {
    const { city, check_in, check_out } = body;
    if (!city || !isDate(check_in) || !isDate(check_out)) {
      throw new HttpError(
        400,
        "hotel search needs city, check_in and check_out (YYYY-MM-DD)",
      );
    }
    const nights = Math.round(
      (Date.parse(check_out) - Date.parse(check_in)) / DAY_MS,
    );
    if (nights < 1)
      throw new HttpError(400, "check_out must be after check_in");
    const offers = await Promise.all(
      hotels
        .filter((h) => h.city === city)
        .map((h) =>
          quote({
            offer_id: `ht:${h.id}:${check_in}:${check_out}`,
            kind: "hotel",
            property: h.id,
            name: h.name,
            city: h.city,
            dest: h.city,
            check_in,
            check_out,
            nights,
            nightly_cents: h.nightly_cents,
            total_cents: h.nightly_cents * nights,
            currency: "USD",
          }),
        ),
    );
    record(
      "booking.searched",
      `${offers.length} hotels in ${city}, ${nights} nights`,
      { kind: "hotel", city, nights },
    );
    return { offers };
  }
  throw new HttpError(400, "kind must be flight or hotel");
}

/** What a reservation asks for: exactly the parameters an approval binds. */
interface Booking extends Record<string, string> {
  offer_id: string;
  quote: string;
  purpose: string;
  payer: string;
}

/** The reservation asked for, with the quote checked against this provider's own key. */
async function readReservation(body: string): Promise<{
  booking: Booking;
  offer: JWTPayload;
}> {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(body);
  } catch {
    throw new AAuthError(400, "invalid_request", "body must be JSON");
  }
  const signer = await bookingSigner();
  const { payload: offer } = await jwtVerify(
    String(request.quote),
    createLocalJWKSet(signer.jwks),
    { issuer: ISSUER },
  ).catch(() => {
    throw new AAuthError(
      400,
      "invalid_request",
      "quote is not signed by this provider",
    );
  });
  if (offer.offer_id !== request.offer_id)
    throw new AAuthError(400, "invalid_request", "offer_id is not the quote's");
  if (Number(offer.valid_until) < now())
    throw new AAuthError(409, "quote_expired", "quote expired; search again");
  if (!["business", "personal"].includes(String(request.purpose)))
    throw new AAuthError(400, "invalid_request", "purpose: business|personal");
  if (!["company", "traveler"].includes(String(request.payer)))
    throw new AAuthError(400, "invalid_request", "payer: company|traveler");
  return {
    booking: {
      offer_id: String(request.offer_id),
      quote: String(request.quote),
      purpose: String(request.purpose),
      payer: String(request.payer),
    },
    offer,
  };
}

const challenge = (
  requirement: Parameters<typeof buildRequirementHeader>[0],
  detail: string,
) =>
  Response.json(
    { error: "unauthorized", detail },
    {
      status: 401,
      headers: {
        "AAuth-Requirement": buildRequirementHeader(requirement),
        "Content-Type": "application/problem+json",
      },
    },
  );

// #region reserve
/**
 * A reservation books on an auth token whose R3 proposal is exactly this
 * booking. Before that the provider asks for what it lacks: a person token
 * (who the agent acts for, and under which mission), then an auth token for
 * this booking, described in a proposal only the person's Person Server reads.
 */
export async function reserve(request: Request): Promise<Response> {
  const body = await request.text();
  if (!request.headers.get("signature-key"))
    return challenge({ requirement: "person-token" }, "sign the request");
  const signed = await verifySignature(request, body, RESERVE_URL);
  const token = await verifyPresented(signed, {
    audience: ISSUER,
    accept: ["agent", "person", "auth"],
    issuers: {
      agent: AGENT_PROVIDERS,
      person: PERSON_SERVERS,
      auth: PERSON_SERVERS,
    },
  });
  if (token.type === "agent")
    return challenge(
      { requirement: "person-token" },
      "present a person token from the traveller's Person Server",
    );
  const { booking, offer } = await readReservation(body);
  if (token.type === "auth" && token.r3_s256) {
    const approved = await verifyProposalParameters({
      store: r3,
      r3_s256: token.r3_s256,
      presented: booking,
      operation: OPERATION,
    }).then(
      () => true,
      () => false,
    );
    if (approved) {
      const earlier = reservations.find(
        (r) => r.auth_token_jti === token.claims.jti,
      );
      return Response.json(earlier ?? book(token, booking, offer));
    }
  }
  return propose(token, signed.thumbprint, booking, offer);
}
// #endregion

// #region propose
/**
 * `401 requirement=auth-token` with a resource token for this one booking:
 * its R3 proposal names the parameters, and only the Person Server may read it.
 * `mission_s256` comes across from the presented token unchanged.
 */
async function propose(
  token: VerifiedToken,
  agentJkt: string,
  booking: Booking,
  offer: JWTPayload,
): Promise<Response> {
  const ps = token.type === "auth" ? token.ps : token.iss;
  const proposal = await publishProposal({
    vocabulary: VOCABULARY,
    operation: OPERATION,
    parameters: booking,
    display: { summary: summarize(booking, offer) },
    store: r3,
    baseUri: `${ISSUER}/r3`,
    authorized: [ps],
  });
  const signer = await bookingSigner();
  const resourceToken = await createResourceToken(
    {
      resource: ISSUER,
      audience: ps,
      presentedToken: token as Parameters<
        typeof createResourceToken
      >[0]["presentedToken"],
      agentJkt,
      scope: SCOPE,
      kid: signer.kid,
      r3: { uri: proposal.r3_uri, s256: proposal.r3_s256 },
    },
    signer.signWithHeader,
  );
  record("booking.challenged", `asked ${ps} to approve ${booking.offer_id}`, {
    offer_id: booking.offer_id,
    ps,
    mission: "mission_s256" in token ? token.mission_s256 : undefined,
  });
  return challenge(
    { requirement: "auth-token", resourceToken },
    `take the resource token to ${ps}`,
  );
}

/** The proposal's one-line description, for whoever approves it. */
function summarize(booking: Booking, offer: JWTPayload): string {
  const dollars = `$${Math.round(Number(offer.total_cents) / 100).toLocaleString("en-US")}`;
  const what =
    offer.kind === "hotel"
      ? `${offer.name}, ${offer.nights} nights`
      : `${offer.flight}, ${offer.cabin}`;
  return `Book ${what} for ${dollars}, ${booking.purpose}, paid by ${booking.payer}`;
}
// #endregion

// #region serve-r3
/** An R3 document, to the Person Server it was published for and no one else. */
export async function serveProposal(
  request: Request,
  key: string,
): Promise<Response> {
  const id = /jwks_uri;(?:[^,]*;)?id="([^"]+)"/.exec(
    request.headers.get("signature-key") ?? "",
  )?.[1];
  if (!id || !PERSON_SERVERS.includes(id))
    throw signatureError(
      "invalid_signature",
      "only the person's Person Server reads a proposal",
    );
  const signed = await verifySignature(
    request,
    undefined,
    `${ISSUER}/r3/${key}`,
  );
  const served = await serveR3Document({
    store: r3,
    key,
    signer: signed.server,
  });
  return new Response(served.body, {
    status: served.status,
    headers: served.headers,
  });
}
// #endregion

function book(
  token: VerifiedToken,
  booking: Booking,
  offer: JWTPayload,
): Reservation {
  const reservation: Reservation = {
    confirmation: `FS-${randomUUID().slice(0, 8).toUpperCase()}`,
    offer_id: booking.offer_id,
    kind: String(offer.kind),
    total_cents: Number(offer.total_cents),
    purpose: booking.purpose,
    payer: booking.payer,
    ps: token.type === "auth" ? token.ps : token.iss,
    sub: token.sub,
    mission_s256: "mission_s256" in token ? token.mission_s256 : undefined,
    auth_token_jti: String(token.claims.jti),
    reserved_at: new Date().toISOString(),
  };
  reservations.push(reservation);
  record(
    "booking.reserved",
    `${reservation.confirmation}: ${reservation.offer_id}, ${reservation.purpose}, paid by ${reservation.payer}`,
    { ...reservation },
  );
  return reservation;
}
