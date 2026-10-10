/**
 * The demo page's own Agent Provider, so the page can run Flight Sector's
 * agent without the platform. It does what the platform's control plane does
 * for a sandboxed agent: publish its keys, and sign an agent token that binds
 * a fresh session key and names the person's Person Server.
 */
import "server-only";

import { createSignedFetch, type GetKeyMaterial } from "@aauth/agent";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { DEMO_AGENT_PROVIDER, PERSON_SERVER_URL } from "../origins";

const KID = "demo-ap-1";

const provider = ((
  globalThis as unknown as {
    __demoAgentProvider?: ReturnType<typeof makeProvider>;
  }
).__demoAgentProvider ??= makeProvider());

function makeProvider() {
  return generateKeyPair("Ed25519", { extractable: true }).then(
    async ({ privateKey, publicKey }) => ({
      privateKey,
      publicJwk: { ...(await exportJWK(publicKey)), kid: KID, alg: "Ed25519" },
    }),
  );
}

export function metadata() {
  return {
    issuer: DEMO_AGENT_PROVIDER,
    jwks_uri: `${DEMO_AGENT_PROVIDER}/jwks.json`,
    name: "Flight Sector demo page",
  };
}

export async function jwks() {
  return { keys: [(await provider).publicJwk] };
}

export const AGENT_ID = `aauth:travel@${new URL(DEMO_AGENT_PROVIDER).hostname}`;

export type DemoAgent = {
  keyMaterial: GetKeyMaterial;
  /** Signs calls to the Person Server, body included. */
  ps: ReturnType<typeof createSignedFetch>;
};

/** A new agent session: its own Ed25519 key, bound by an agent token. */
export async function newAgent(): Promise<DemoAgent> {
  const { privateKey } = await provider;
  const keys = await generateKeyPair("Ed25519", { extractable: true });
  const publicJwk = { ...(await exportJWK(keys.publicKey)), alg: "Ed25519" };
  const signingKey = { ...(await exportJWK(keys.privateKey)), alg: "Ed25519" };
  const iat = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({
    iss: DEMO_AGENT_PROVIDER,
    dwk: "aauth-agent.json",
    sub: AGENT_ID,
    ps: PERSON_SERVER_URL,
    jti: crypto.randomUUID(),
    iat,
    exp: iat + 3600,
    cnf: { jwk: publicJwk },
  })
    .setProtectedHeader({ alg: "Ed25519", typ: "aa-agent+jwt", kid: KID })
    .sign(privateKey);
  const keyMaterial: GetKeyMaterial = async () => ({
    signingKey,
    signatureKey: { type: "jwt", jwt },
  });
  return {
    keyMaterial,
    ps: createSignedFetch(keyMaterial, { signBody: true }),
  };
}
