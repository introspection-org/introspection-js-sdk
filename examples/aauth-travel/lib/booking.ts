/**
 * Flight Sector's booking provider, a native AAuth resource. Every offer
 * carries a quote this provider signs. Policy is not this provider's job: a
 * reservation needs a person token from the traveller's Person Server, then an
 * auth token from it for exactly this booking, which the provider describes in
 * a per-call R3 proposal only that Person Server may read.
 */
import "server-only";

import { randomUUID } from "node:crypto";

import type { VerifiedToken } from "@aauth/resource";
import {
  type AAuthResource,
  createAAuthResource,
} from "@introspection-sdk/aauth-resource";
import type { JWTPayload } from "jose";

import { AAuthError, now } from "./aauth";
import { record } from "./events";
import { HttpError } from "./http";
import {
  agentProviders,
  BOOKING_ISSUER,
  HOSTED_PERSON_SERVER_URL,
  PERSON_SERVER_URL,
} from "./origins";
import { type Flight, flights, hotels } from "./world";

const QUOTE_TTL_SECONDS = 30 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISSUER = BOOKING_ISSUER;
const SCOPE = "booking.reserve";
const RESERVE_URL = `${ISSUER}/v1/reserve`;
const CANCEL_URL = `${ISSUER}/v1/cancel`;
/** The R3 vocabulary this provider describes bookings in. */
const VOCABULARY = `${ISSUER}/r3/vocabulary`;
const BUDGET_UNIT = { unit: "USD", decimals: 2 } as const;
const OPERATION = { action: "reserve" };
// Person Servers whose people this provider serves. Fetching an issuer's keys
// is egress, so the list is closed.
const PERSON_SERVERS = (
  process.env.BOOKING_PERSON_SERVERS ||
  [PERSON_SERVER_URL, HOSTED_PERSON_SERVER_URL].filter(Boolean).join(",")
)
  .split(",")
  .map((url) => url.trim().replace(/\/+$/, ""))
  .filter(Boolean);

// One resource per process, shared across route modules (Next bundles each
// route separately, so module scope alone would mint a key and an R3 store per route).
const registry = globalThis as unknown as {
  __flightSectorBooking?: Promise<AAuthResource>;
};

// #region metadata
/**
 * The provider as an AAuth resource (@introspection-sdk/aauth-resource): its
 * metadata at `/.well-known/aauth-resource.json`, its key, and its proposals.
 */
export const bookingResource = () =>
  (registry.__flightSectorBooking ??= createAAuthResource({
    issuer: ISSUER,
    name: "Flight Sector Booking",
    description:
      "Flights and hotels for company travel. Search is open; a reservation needs an auth token from the traveller's Person Server.",
    scopes: { [SCOPE]: "Reserve the quoted flight or hotel" },
    vocabulary: VOCABULARY,
    // draft-hardt-aauth-budgets: each resource token's `budget` is its booking's price.
    budgetUnits: [{ unit: BUDGET_UNIT.unit, decimals: BUDGET_UNIT.decimals }],
    personServers: PERSON_SERVERS,
    agentProviders: agentProviders(),
    // Set a PEM to keep the key across restarts; otherwise each process makes its own.
    signingKey: process.env.BOOKING_SIGNING_KEY,
    kid: "flightsector-booking-1",
    onPropose: ({ ps, parameters, mission_s256 }) =>
      record(
        "booking.challenged",
        `asked ${ps} to approve ${parameters.offer_id}`,
        {
          offer_id: parameters.offer_id,
          ps,
          mission: mission_s256,
        },
      ),
  }));
// #endregion

/** `/.well-known/aauth-resource.json`: how an agent plans its first call. */
export async function resourceMetadata() {
  return (await bookingResource()).metadata();
}

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
  /** When the flight departs or the stay begins: a booking can be cancelled until then. */
  starts_at: string;
  reserved_at: string;
  cancelled_at?: string;
}

const store = globalThis as unknown as {
  __flightSectorReservations?: Reservation[];
};
export const reservations = (store.__flightSectorReservations ??= []);

// #region quote
/** Sign an offer's facts. The quote is what the Person Server decides on. */
async function quote(offer: Record<string, unknown>) {
  const iat = Math.floor(Date.now() / 1000);
  const valid_until = iat + QUOTE_TTL_SECONDS;
  const quote = await (
    await bookingResource()
  ).sign({ ...offer, iat, valid_until });
  return { ...offer, valid_until, quote };
}
// #endregion

function flightOffer(f: Flight, date: string, cabin: string) {
  return quote({
    offer_id: `fl:${f.id}:${date}:${cabin}`,
    kind: "flight",
    carrier: f.carrier,
    flight: f.flight,
    from: f.from,
    to: f.to,
    dest: f.to,
    depart: `${date}T${f.depart_time}`,
    block_minutes: f.block_minutes,
    stops: f.stops,
    cabin,
    total_cents: f.fares_cents[cabin],
    currency: "USD",
  });
}

const CARRIERS: Record<string, string> = { qantas: "QF", united: "UA" };

/**
 * Quote a flight the agent found elsewhere, such as through a browser search:
 * by flight number, or by carrier on the route. The fare is this provider's,
 * never the price the agent saw.
 */
export async function quoteFlight(body: Record<string, unknown>) {
  const { from, to, date } = body;
  const cabin = typeof body.cabin === "string" ? body.cabin : "economy";
  if (!from || !to || !isDate(date)) {
    throw new HttpError(400, "a quote needs from, to and date (YYYY-MM-DD)");
  }
  const number = String(body.flight ?? "")
    .toUpperCase()
    .replace(/\s+/g, "");
  const carrier = String(body.carrier ?? "").trim();
  const code = CARRIERS[carrier.toLowerCase()] ?? carrier.toUpperCase();
  const match = flights.find(
    (f) =>
      f.from === from &&
      f.to === to &&
      (number ? f.flight === number : f.carrier === code),
  );
  if (!match) {
    throw new HttpError(
      404,
      `no ${carrier || number || "such"} flight ${from}→${to} is sold here`,
    );
  }
  if (!(cabin in match.fares_cents)) {
    throw new HttpError(404, `${match.flight} has no ${cabin} fare`);
  }
  const offer = await flightOffer(match, date, cabin);
  record(
    "booking.quoted",
    `${match.flight} ${from}→${to} on ${date}, ${cabin}`,
    {
      kind: "flight",
      flight: match.flight,
      date,
      cabin,
    },
  );
  return { offer };
}

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
          Object.keys(f.fares_cents)
            .filter((fareCabin) => !cabin || fareCabin === cabin)
            .map((fareCabin) => flightOffer(f, date, fareCabin)),
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
  const offer = await (
    await bookingResource()
  )
    .verifySigned(String(request.quote))
    .catch(() => {
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

// #region reserve
/**
 * A reservation books on an auth token whose R3 proposal is exactly this
 * booking. Until then the resource asks for what is lacking: a person token
 * (who the agent acts for, and under which mission), then an auth token for
 * this booking, described in a proposal only the person's Person Server reads.
 * The booking is read only once the presented token verifies.
 */
export async function reserve(request: Request): Promise<Response> {
  const body = await request.text();
  let asked: { booking: Booking; offer: JWTPayload } | undefined;
  const authz = await (
    await bookingResource()
  ).authorize(
    request,
    body,
    async () => {
      asked = await readReservation(body);
      const { booking, offer } = asked;
      return {
        scope: SCOPE,
        operation: OPERATION,
        parameters: booking,
        summary: summarize(booking, offer),
        // The price, as a budgets-draft budget, so any Person Server can weigh it without reading R3.
        budget: { amount: Number(offer.total_cents), ...BUDGET_UNIT },
      };
    },
    { url: RESERVE_URL },
  );
  if (!authz.ok) return authz.response;
  const { booking, offer } = asked!;
  const earlier = reservations.find((r) => r.auth_token_jti === authz.jti);
  return Response.json(earlier ?? book(authz.token, booking, offer));
}
// #endregion

// #region cancel
/**
 * Cancel a booking on the person token of the agent that made it: one booked
 * under the same mission, before the flight departs or the stay begins. It
 * spends nothing, so no Person Server is asked. Cancelling twice answers the
 * same cancellation.
 */
export async function cancel(request: Request): Promise<Response> {
  const body = await request.text();
  const caller = await (
    await bookingResource()
  ).authenticate(request, body, { url: CANCEL_URL });
  if (!caller.ok) return caller.response;
  let confirmation: unknown;
  try {
    confirmation = JSON.parse(body).confirmation;
  } catch {
    throw new AAuthError(400, "invalid_request", "body must be JSON");
  }
  const reservation = reservations.find(
    (r) =>
      r.confirmation === confirmation &&
      r.ps === caller.ps &&
      (r.mission_s256
        ? r.mission_s256 === caller.mission_s256
        : r.sub === caller.sub),
  );
  if (!reservation)
    throw new AAuthError(
      404,
      "not_found",
      `no booking ${String(confirmation)} under this trip`,
    );
  if (reservation.cancelled_at) return Response.json(reservation);
  if (Date.parse(reservation.starts_at) <= Date.now())
    throw new AAuthError(
      409,
      "already_started",
      `${reservation.confirmation} has already started and can no longer be cancelled`,
    );
  reservation.cancelled_at = new Date().toISOString();
  record(
    "booking.cancelled",
    `${reservation.confirmation}: ${reservation.offer_id}`,
    { ...reservation },
  );
  return Response.json(reservation);
}
// #endregion

/** The proposal's one-line description, for whoever approves it. */
function summarize(booking: Booking, offer: JWTPayload): string {
  const dollars = `$${Math.round(Number(offer.total_cents) / 100).toLocaleString("en-US")}`;
  const what =
    offer.kind === "hotel"
      ? `${offer.name}, ${offer.nights} nights`
      : `${offer.flight}, ${offer.cabin}`;
  return `Book ${what} for ${dollars}, ${booking.purpose}, paid by ${booking.payer}`;
}

/** An R3 document, to the Person Server it was published for and no one else. */
export async function serveProposal(
  request: Request,
  key: string,
): Promise<Response> {
  return (await bookingResource()).serveProposal(request, key);
}

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
    starts_at: String(offer.kind === "hotel" ? offer.check_in : offer.depart),
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
