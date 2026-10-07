// What the booking provider sells. Offer ids are opaque to the agent and to the
// platform; Acme's Person Server looks an offer up by id to apply its policy.
export const OFFERS = [
  {
    offer_id: "fl-sfo-syd-qf74",
    kind: "flight",
    from: "SFO",
    to: "SYD",
    date: "2026-10-17",
    name: "QF74 direct, business",
    total: 6400,
  },
  {
    offer_id: "fl-syd-mel-qf431",
    kind: "flight",
    from: "SYD",
    to: "MEL",
    date: "2026-10-23",
    name: "QF431",
    total: 180,
  },
  {
    offer_id: "fl-mel-sfo-ua60",
    kind: "flight",
    from: "MEL",
    to: "SFO",
    date: "2026-10-26",
    name: "UA60 direct, economy",
    total: 1450,
  },
  {
    offer_id: "ht-syd-qt",
    kind: "hotel",
    city: "SYD",
    name: "QT Sydney",
    nightly_rate: 420,
    nights: 4,
    total: 1680,
  },
  {
    offer_id: "ht-syd-vibe",
    kind: "hotel",
    city: "SYD",
    name: "Vibe Hotel Sydney",
    nightly_rate: 280,
    nights: 4,
    total: 1120,
  },
  {
    offer_id: "ht-mel-ovolo",
    kind: "hotel",
    city: "MEL",
    name: "Ovolo Laneways",
    nightly_rate: 240,
    nights: 3,
    total: 720,
  },
];

export function findOffer(offerId) {
  return OFFERS.find((offer) => offer.offer_id === offerId) ?? null;
}

export function searchOffers(query) {
  return OFFERS.filter((offer) => {
    if (offer.kind !== query.kind) return false;
    if (offer.kind === "hotel") return !query.city || offer.city === query.city;
    return (
      (!query.from || offer.from === query.from) &&
      (!query.to || offer.to === query.to)
    );
  });
}
