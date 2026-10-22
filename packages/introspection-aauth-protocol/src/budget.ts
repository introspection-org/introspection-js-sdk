import { InvalidRequest } from "./errors.js";

/** A draft-hardt-aauth-budgets budget: `amount / 10 ** decimals` in `unit`. */
export interface Budget {
  amount: number;
  unit: string;
  decimals: number;
}

/**
 * A budget as a token or request carries it, or `undefined` when there is
 * none. Anything else is refused: the amount is a non-negative integer in the
 * stated scale, so no grant can be negative and no spend can go backwards.
 */
export function parseBudget(value: unknown): Budget | undefined {
  if (value === undefined || value === null) return undefined;
  const { amount, unit, decimals } = (
    typeof value === "object" ? value : {}
  ) as Partial<Budget>;
  if (
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    typeof unit !== "string" ||
    !unit ||
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0
  )
    throw new InvalidRequest(
      "a budget is {amount, unit, decimals}: a non-negative integer amount in that unit's scale",
    );
  return { amount, unit, decimals };
}

/** Whether two budgets are in the same unit and scale, so their amounts compare. */
export const sameScale = (a: Budget, b: Budget): boolean =>
  a.unit === b.unit && a.decimals === b.decimals;
