/** The demo page's sample prompts. */

/** `from` to `to`, as a traveller writes it: "26 to 30 October", or "30 November to 4 December". */
function span(from: Date, to: Date) {
  const month = (d: Date) => d.toLocaleString("en-GB", { month: "long" });
  return month(from) === month(to)
    ? `${from.getDate()} to ${to.getDate()} ${month(to)}`
    : `${from.getDate()} ${month(from)} to ${to.getDate()} ${month(to)}`;
}

/** Next week, Monday to Friday, and the weekend after it, from `today`. */
export function tripDates(today = new Date()) {
  const day = (offset: number) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  const monday = (8 - today.getDay()) % 7 || 7;
  return {
    week: span(day(monday), day(monday + 4)),
    weekend: span(day(monday + 4), day(monday + 6)),
  };
}

/** The demo's scenarios, dated next week so a trip is never in the past. */
export function scenarios(today = new Date()) {
  const { week, weekend } = tripDates(today);
  return [
    {
      id: "approved",
      title: "Over budget, Dana declines, Sam's easy",
      prompt: `Book me economy from San Francisco to Sydney for ${week}, and the QT Sydney. Up to $3,000.`,
      hint: "Approve the trip at $3,000. The flight books on its own; decline the QT when Dana is asked, then tell the agent you're easy and it finds a cheaper hotel.",
    },
    {
      id: "first",
      title: "First class: refused by the rails",
      prompt: `Fly me first class from San Francisco to Sydney for ${week}, with the Harbour Rocks. Up to $20,000.`,
      hint: "The agent quotes first class, and Flight Sector's Cedar rails in Introspection's egress refuse it at the quote, before Acme is asked.",
    },
    {
      id: "personal",
      title: "A personal weekend on the company: refused",
      prompt: `Book me economy from San Francisco to Sydney for ${week} for the Acme offsite, then on to Melbourne for a weekend with my partner, ${weekend}. Put it all on Acme. Up to $4,000.`,
      hint: "Approve the trip. Sydney books on the company; the rails refuse the Melbourne weekend on the company, with Jev reading it as personal, so the agent offers to put it on Sam's card.",
    },
  ];
}
