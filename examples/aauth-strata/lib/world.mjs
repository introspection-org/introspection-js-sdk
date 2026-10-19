// Alder Court, owners corporation RP4417 (VIC). ALL DATA IS FICTIONAL.
// The same scheme as the strata recipe's stub (introspection-org/recipe-strata-vendor).

export const SCHEME = "RP4417";

/** Lots, their entitlement, and who is in arrears (their ordinary-resolution votes don't count). */
export const lots = [
  88, 96, 104, 92, 110, 96, 100, 104, 112, 96, 100, 108, 92, 96, 104, 100, 88,
  108, 106,
].map((entitlement, i) => ({
  lot: i + 1,
  entitlement,
  in_arrears: i + 1 === 6 || i + 1 === 14,
}));

/** This financial year's budget lines, in cents. */
export const budgetLines = {
  general_repairs: { budget_cents: 700000, spent_cents: 440000 },
};

export const vendors = {
  "V-403": { name: "Northside Plumbing", insured: true },
  "V-404": { name: "Budget Pipes", insured: false },
  "V-405": { name: "Metro Drain Relining", insured: true },
};

export const quotes = {
  "WR-2026-0433": [
    {
      quote_id: "Q-9101",
      trade: "plumbing",
      area: "common",
      responsibility: "owners_corporation",
      vendor_id: "V-403",
      total_cents: 198000,
      budget_line: "general_repairs",
      benefit_lots: null,
      scope:
        "Replace the failed stack pipe joint behind Lot 10's bathroom, pressure test, make good the Lot 7 hallway ceiling.",
    },
  ],
  "WR-2026-0435": [
    {
      quote_id: "Q-9120",
      trade: "drainage",
      area: "common",
      responsibility: "owners_corporation",
      vendor_id: "V-405",
      total_cents: 935000,
      budget_line: "general_repairs",
      benefit_lots: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      scope:
        "Reline 24 m of collapsed storm-water drain along the driveway, which floods against the walls of Lots 1-10.",
    },
  ],
};
