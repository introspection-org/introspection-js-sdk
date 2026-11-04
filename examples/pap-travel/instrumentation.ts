/**
 * At boot: Flight Sector also sells QF8 via Dallas, the dearer way to Sydney
 * in this story, and on the hosted Person Server Acme's approval app follows
 * the platform's approvals, as in aauth-travel.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { flights } =
    await import("introspection-example-travel-demo-flow/world");
  if (!flights.some((f) => f.id === "qf8"))
    flights.push({
      id: "qf8",
      carrier: "QF",
      flight: "QF8",
      from: "SFO",
      to: "SYD",
      depart_time: "17:40",
      block_minutes: 1095,
      stops: 1,
      fares_cents: { economy: 205000, business: 820000 },
    });
  const { PERSON_SERVER_MODE } =
    await import("introspection-example-travel-demo-flow/origins");
  if (PERSON_SERVER_MODE === "hosted")
    (
      await import("introspection-example-travel-demo-flow/acme/hosted")
    ).start();
}
