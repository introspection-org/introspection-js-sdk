/** On the hosted Person Server, Acme's approval app follows the platform's approvals from boot. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { PERSON_SERVER_MODE } = await import("./lib/origins");
  if (PERSON_SERVER_MODE === "hosted")
    (await import("./lib/acme/hosted")).start();
}
