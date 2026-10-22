/** Whether `url` is on the https origin of `issuer`, and carries no credentials. */
export function onOrigin(url: string, issuer: unknown): boolean {
  try {
    const at = new URL(url);
    return (
      typeof issuer === "string" &&
      at.protocol === "https:" &&
      !at.username &&
      !at.password &&
      at.origin === new URL(issuer).origin
    );
  } catch {
    return false;
  }
}
