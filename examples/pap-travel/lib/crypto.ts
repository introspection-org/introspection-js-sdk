import { base64url } from "jose";

/** Random URL-safe characters: 16 bytes make 22 of them, the least a `sid` or `jti` may have. */
export const random = (bytes = 16) =>
  base64url.encode(crypto.getRandomValues(new Uint8Array(bytes)));

/** SHA-256, base64url-encoded: PKCE challenges and `ath`. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return base64url.encode(new Uint8Array(digest));
}

export const now = () => Math.floor(Date.now() / 1000);
