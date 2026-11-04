/** On the hosted Person Server, Acme's approval app follows the platform's approvals from boot. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { PERSON_SERVER_MODE } =
    await import("introspection-example-travel-demo-flow/origins");
  if (PERSON_SERVER_MODE === "hosted")
    (
      await import("introspection-example-travel-demo-flow/acme/hosted")
    ).start();
}
