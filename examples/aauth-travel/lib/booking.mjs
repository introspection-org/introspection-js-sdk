// The booking provider. A reservation needs the connection's token, which the
// platform's egress injects only for a request its mission gate has let through.
import { randomUUID } from "node:crypto";

import { findOffer, searchOffers } from "./catalog.mjs";

export function createBooking({ token }) {
  const reservations = [];
  return {
    reservations,
    search(body) {
      return { status: 200, body: { offers: searchOffers(body) } };
    },
    reserve(body, headers) {
      if (headers.authorization !== `Bearer ${token}`) {
        return {
          status: 401,
          body: { error: "the booking connection's token is required" },
        };
      }
      const offer = findOffer(body.offer_id);
      if (!offer) return { status: 404, body: { error: "no such offer" } };
      const reservation = {
        confirmation: `BK-${randomUUID().slice(0, 8).toUpperCase()}`,
        offer,
      };
      reservations.push(reservation);
      return { status: 200, body: reservation };
    },
  };
}
