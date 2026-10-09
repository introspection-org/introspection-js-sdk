/**
 * Flight Sector's booking provider, a native AAuth resource. Every offer
 * carries a quote this provider signs, so whoever decides reads trip facts the
 * agent cannot alter. Policy is not this provider's job: it asks for an auth
 * token from the person's own Person Server, naming exactly the quote to be
 * booked, and books when one arrives.
 */
import "server-only";

import { randomUUID } from "node:crypto";

import { type JWTPayload, createLocalJWKSet, jwtVerify } from "jose";

import {
  AAuthError,
  TYP,
  TokenError,
  assertBound,
  now,
  requirement,
  signatureError,
  verifySignature,
  verifyToken,
} from "./aauth";
import { record } from "./events";
import { HttpError } from "./http";
import { BOOKING_ISSUER, PERSON_SERVER_URL } from "./origins";
import { bookingSigner } from "./signing";
import { flights, hotels } from "./world";

const QUOTE_TTL_SECONDS = 30 * 60;
const RESOURCE_TOKEN_TTL_SECONDS = 5 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISSUER = BOOKING_ISSUER;
const SCOPE = "booking.reserve";
const RESERVE_URL = new URL(`${ISSUER}/v1/reserve`);
const closedList = (raw: string) =>
  raw
    .split(",")
    .map((url) => url.trim().replace(/\/+$/, ""))
    .filter(Boolean);
// Person Servers whose people this provider serves, and the agent providers
// whose agents it talks to. Fetching an issuer's keys is egress, so both lists
// are closed.
const PERSON_SERVERS = closedList(
  process.env.BOOKING_PERSON_SERVERS || PERSON_SERVER_URL,
);
const AGENT_PROVIDERS = closedList(
  process.env.BOOKING_AGENT_PROVIDERS ||
    (process.env.NODE_ENV === "production"
      ? ""
      : "http://localhost:8000,http://localhost:3499"),
);

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

/** RFC 9396 authorization details: what a grant at this provider covers. */
interface BookingDetail {
  type: "booking";
  offer_id: string;
  quote: string;
  purpose: string;
  payer: string;
}

/** The reservation asked for, with the quote checked against this provider's own key. */
async function readReservation(body: string): Promise<{
  detail: BookingDetail;
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
    detail: {
      type: "booking",
      offer_id: String(request.offer_id),
      quote: String(request.quote),
      purpose: String(request.purpose),
      payer: String(request.payer),
    },
    offer,
  };
}

const signatureRequired = () =>
  new Response(null, {
    status: 401,
    headers: { "AAuth-Requirement": requirement("auth-token") },
  });

// #region reserve
/**
 * A reservation books only on an auth token from the traveller's Person Server
 * that grants `booking.reserve` for exactly this quote, purpose and payer. An
 * agent's first call presents its agent token, and gets a resource token to
 * take to the Person Server its agent token names.
 */
export async function reserve(request: Request): Promise<Response> {
  const body = await request.text();
  if (!request.headers.get("signature-key")) return signatureRequired();
  const signed = await verifySignature(request, body, {
    authority: RESERVE_URL.host,
    path: RESERVE_URL.pathname,
  });
  if (signed.keyType !== "jwt" || !signed.jwt)
    throw signatureError("unsupported_scheme", "sign with sig=jwt");
  const typ = signed.jwt.typ;
  if (typ !== TYP.agent && typ !== TYP.auth)
    throw signatureError("invalid_jwt", "present an agent or auth token");

  const token = await verifyToken(
    signed.jwt.raw,
    typ === TYP.agent
      ? { typ, dwk: "aauth-agent.json", issuers: AGENT_PROVIDERS }
      : { typ, dwk: "aauth-person.json", issuers: PERSON_SERVERS },
  ).catch((err: Error) => {
    const expired = err instanceof TokenError && err.reason === "expired";
    throw signatureError(expired ? "expired_jwt" : "invalid_jwt", err.message);
  });
  await assertBound(token, signed);
  if (typ === TYP.auth && token.aud !== ISSUER)
    throw signatureError("invalid_jwt", "aud is not this resource");

  const { detail, offer } = await readReservation(body);
  if (typ === TYP.auth && grants(token, detail)) {
    const earlier = reservations.find((r) => r.auth_token_jti === token.jti);
    return Response.json(earlier ?? book(token, detail, offer));
  }
  return challenge(token, typ, signed.thumbprint, detail);
}

function grants(token: JWTPayload, detail: BookingDetail): boolean {
  const scopes = String(token.scope ?? "").split(" ");
  const details = (token.authorization_details ?? []) as BookingDetail[];
  return (
    scopes.includes(SCOPE) &&
    details.some(
      (d) =>
        d.type === "booking" &&
        d.offer_id === detail.offer_id &&
        d.quote === detail.quote &&
        d.purpose === detail.purpose &&
        d.payer === detail.payer,
    )
  );
}
// #endregion

// #region challenge
/**
 * `401 requirement=auth-token` with a resource token: this provider, the
 * agent's key, the scope, and the quote. Its audience is the person's Person
 * Server: the agent token's `ps`, or the issuer of the auth token presented.
 */
async function challenge(
  token: JWTPayload,
  typ: string,
  agentJkt: string,
  detail: BookingDetail,
): Promise<Response> {
  const ps = String(token.ps ?? (typ === TYP.auth ? token.iss : ""));
  if (!PERSON_SERVERS.includes(ps))
    throw new AAuthError(
      403,
      "invalid_request",
      "this agent's Person Server is not one this provider serves",
    );
  const iat = now();
  const resourceToken = await (
    await bookingSigner()
  ).sign(
    {
      iss: ISSUER,
      dwk: "aauth-resource.json",
      aud: ps,
      ps,
      presented_jti: token.jti,
      agent_jkt: agentJkt,
      scope: SCOPE,
      authorization_details: [detail],
      jti: randomUUID(),
      iat,
      exp: iat + RESOURCE_TOKEN_TTL_SECONDS,
    },
    TYP.resource,
  );
  record("booking.challenged", `asked ${ps} for an auth token`, {
    offer_id: detail.offer_id,
    ps,
    presented: typ,
  });
  return Response.json(
    {
      error: "auth_token_required",
      detail: `take the resource token to ${ps}`,
    },
    {
      status: 401,
      headers: {
        "AAuth-Requirement": requirement("auth-token", {
          "resource-token": resourceToken,
        }),
        "Content-Type": "application/problem+json",
      },
    },
  );
}
// #endregion

function book(
  token: JWTPayload,
  detail: BookingDetail,
  offer: JWTPayload,
): Reservation {
  const reservation: Reservation = {
    confirmation: `FS-${randomUUID().slice(0, 8).toUpperCase()}`,
    offer_id: detail.offer_id,
    kind: String(offer.kind),
    total_cents: Number(offer.total_cents),
    purpose: detail.purpose,
    payer: detail.payer,
    ps: String(token.iss),
    sub: String(token.sub),
    auth_token_jti: String(token.jti),
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
