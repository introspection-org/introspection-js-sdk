/**
 * The owners corporation's works API, a native AAuth resource (ALL DATA IS
 * FICTIONAL). Quotes are open and signed. A work order or a special levy needs
 * an auth token from the occupant's Person Server for exactly that call, with
 * its price as the budget: a work order in AUD, which a repair's approved
 * budget can carry, and a special levy in `AUD-levy`, which no mission budget
 * carries, so the owners corporation always decides it.
 */
import { randomUUID } from "node:crypto";

import {
  AAuthError,
  createAAuthResource,
  problem,
  respond,
} from "@introspection-sdk/aauth-resource";

import { SCHEME, budgetLines, lots, quotes, vendors } from "./world.mjs";

export const ORDER_UNIT = { unit: "AUD", decimals: 2 };
export const LEVY_UNIT = { unit: "AUD-levy", decimals: 2 };
const QUOTE_TTL_SECONDS = 7 * 24 * 3600;

export async function createWorks({
  issuer,
  personServers,
  agentProviders,
  signingKey,
  onEvent = () => {},
}) {
  const resource = await createAAuthResource({
    issuer,
    name: "Alder Court works (fictional)",
    description:
      "Quotes are open; a work order or special levy needs an auth token from the occupant's Person Server.",
    scopes: {
      "works.order": "Issue a work order on a quote",
      "works.levy": "Raise a special levy for a quote",
    },
    budgetUnits: [ORDER_UNIT, LEVY_UNIT],
    personServers,
    agentProviders,
    signingKey,
  });
  const workOrders = [],
    levies = [];

  async function readQuote(body) {
    let request;
    try {
      request = JSON.parse(body);
    } catch {
      throw new AAuthError(400, "invalid_request", "body must be JSON");
    }
    const quote = await resource.verifySigned(String(request.quote));
    if (quote.quote_id !== request.quote_id)
      throw new AAuthError(
        400,
        "invalid_request",
        "quote_id is not the quote's",
      );
    if (Number(quote.valid_until) < Date.now() / 1000)
      throw new AAuthError(409, "quote_expired", "quote expired; quote again");
    return { request, quote };
  }

  const dollars = (cents) =>
    `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 2 })}`;

  async function quotesFor(body) {
    const { request_id } = JSON.parse(body || "{}");
    const list = quotes[request_id];
    if (!list)
      throw new AAuthError(
        404,
        "not_found",
        `no request ${request_id} for ${SCHEME}`,
      );
    const iat = Math.floor(Date.now() / 1000);
    return Promise.all(
      list.map(async (q) => {
        const line = budgetLines[q.budget_line];
        const facts = {
          quote_id: q.quote_id,
          request_id,
          scheme: SCHEME,
          vendor: vendors[q.vendor_id].name,
          contractor_insured: vendors[q.vendor_id].insured,
          trade: q.trade,
          area: q.area,
          responsibility: q.responsibility,
          total_cents: q.total_cents,
          budget_line: q.budget_line,
          budget_remaining_cents: line.budget_cents - line.spent_cents,
          benefit: q.benefit_lots ? "some_lots" : "all_lots",
          ...(q.benefit_lots ? { benefit_lots: q.benefit_lots } : {}),
          scope: q.scope,
        };
        return {
          ...facts,
          quote: await resource.sign({
            ...facts,
            iat,
            valid_until: iat + QUOTE_TTL_SECONDS,
          }),
        };
      }),
    );
  }

  async function order(request, body) {
    const { quote } = await readQuote(body);
    const authz = await resource.authorize(request, body, {
      scope: "works.order",
      operation: { action: "order" },
      parameters: { quote_id: String(quote.quote_id) },
      summary: `Order ${quote.quote_id} from ${quote.vendor} for ${dollars(quote.total_cents)}: ${quote.scope}`,
      budget: { amount: Number(quote.total_cents), ...ORDER_UNIT },
    });
    if (!authz.ok) return authz.response;
    const earlier = workOrders.find((w) => w.auth_token_jti === authz.jti);
    if (earlier) return Response.json(earlier);
    // The works system keeps its own rules; the egress rails are not its only gate.
    if (!quote.contractor_insured)
      return problem(
        403,
        "contractor_uninsured",
        `${quote.vendor} has no current insurance on file`,
      );
    const line = budgetLines[quote.budget_line];
    if (quote.total_cents > line.budget_cents - line.spent_cents)
      return problem(
        403,
        "over_budget",
        `over what is left of ${quote.budget_line}; propose a special levy`,
      );
    line.spent_cents += quote.total_cents;
    const wo = {
      id: `WO-${randomUUID().slice(0, 8).toUpperCase()}`,
      quote_id: quote.quote_id,
      vendor: quote.vendor,
      total_cents: quote.total_cents,
      sub: authz.sub,
      ps: authz.ps,
      mission_s256: authz.mission_s256,
      auth_token_jti: authz.jti,
    };
    workOrders.push(wo);
    onEvent("works.ordered", wo);
    return Response.json(wo);
  }

  async function levy(request, body) {
    const { request: req, quote } = await readQuote(body);
    const apportion = req.apportion === "benefit" ? "benefit" : "lot_liability";
    if (quote.benefit === "some_lots" && apportion !== "benefit")
      return problem(
        409,
        "benefit_principle",
        "works that benefit only some lots are levied on those lots by benefit",
      );
    const payers =
      apportion === "benefit" ? quote.benefit_lots : lots.map((l) => l.lot);
    const authz = await resource.authorize(request, body, {
      scope: "works.levy",
      operation: { action: "levy" },
      parameters: { quote_id: String(quote.quote_id), apportion },
      summary: `Special levy of ${dollars(quote.total_cents)} for ${quote.quote_id} (${quote.vendor}), ${apportion === "benefit" ? `Lots ${payers[0]}-${payers.at(-1)} by benefit` : "every lot by liability"}: ${quote.scope}`,
      budget: { amount: Number(quote.total_cents), ...LEVY_UNIT },
    });
    if (!authz.ok) return authz.response;
    const earlier = levies.find((l) => l.auth_token_jti === authz.jti);
    if (earlier) return Response.json(earlier);
    const each = Math.round(quote.total_cents / payers.length);
    const raised = {
      id: `SL-${randomUUID().slice(0, 8).toUpperCase()}`,
      quote_id: quote.quote_id,
      total_cents: quote.total_cents,
      apportion,
      shares: payers.map((lot) => ({ lot, cents: each })),
      auth_token_jti: authz.jti,
      mission_s256: authz.mission_s256,
    };
    levies.push(raised);
    onEvent("works.levy_raised", raised);
    return Response.json(raised);
  }

  return {
    resource,
    workOrders,
    levies,
    /** Every route of the works API. */
    async handle(request) {
      const served = await resource.handle(request);
      if (served) return served;
      const { pathname } = new URL(request.url);
      if (request.method !== "POST") return problem(404, "not_found");
      const body = await request.text();
      if (pathname === "/v1/quotes")
        return respond(async () =>
          Response.json({ scheme: SCHEME, quotes: await quotesFor(body) }),
        );
      if (pathname === "/v1/work-orders")
        return respond(() => order(request, body));
      if (pathname === "/v1/special-levies")
        return respond(() => levy(request, body));
      return problem(404, "not_found");
    },
  };
}
