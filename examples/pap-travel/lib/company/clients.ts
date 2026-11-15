/**
 * Who a Personal Agent is: its Client ID Metadata Document, fetched from its
 * `client_id` without following redirects, and the keys in its `jwks_uri`
 * (spec 4.1, 5.3).
 */
import "server-only";

import { createRemoteJWKSet } from "jose";

import { once } from "../once";
import { reachable } from "../origins";

export type ClientMetadata = {
  client_id: string;
  client_name: string;
  jwks_uri: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  extensions?: Record<string, { version: string }>;
};

const CACHE_SECONDS = 60;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/;

const cache = once("company_clients", () => ({
  metadata: new Map<string, { at: number; metadata: ClientMetadata }>(),
  keys: new Map<string, ReturnType<typeof createRemoteJWKSet>>(),
}));

/** Fetches and checks a client's metadata; throws with what is wrong. */
export async function clientMetadata(
  clientId: string,
): Promise<ClientMetadata> {
  const cached = cache.metadata.get(clientId);
  if (cached && Date.now() - cached.at < CACHE_SECONDS * 1000)
    return cached.metadata;
  const url = reachable(clientId);
  const response = await fetch(url, {
    redirect: "manual",
    cache: "no-store",
  }).catch(() => null);
  if (response?.status !== 200)
    throw new Error("the client metadata is unavailable");
  const metadata = (await response.json()) as ClientMetadata;
  const onDomain = (u: string) =>
    u.startsWith("https://") && new URL(u).hostname === url.hostname;
  if (metadata.client_id !== clientId)
    throw new Error("client_id is not the URL it was fetched from");
  if (!onDomain(metadata.jwks_uri ?? ""))
    throw new Error("jwks_uri is not on the client_id's domain");
  if (
    !Array.isArray(metadata.redirect_uris) ||
    !metadata.redirect_uris.every((u) => onDomain(u) || LOOPBACK.test(u))
  )
    throw new Error("a redirect_uri is not on the client_id's domain");
  if (metadata.token_endpoint_auth_method !== "private_key_jwt")
    throw new Error("token_endpoint_auth_method is not private_key_jwt");
  cache.metadata.set(clientId, { at: Date.now(), metadata });
  return metadata;
}

/** The client's published keys, refetched by jose when a `kid` is new. */
export function clientKeys(metadata: ClientMetadata) {
  let keys = cache.keys.get(metadata.jwks_uri);
  if (!keys) {
    keys = createRemoteJWKSet(reachable(metadata.jwks_uri));
    cache.keys.set(metadata.jwks_uri, keys);
  }
  return keys;
}

/** Whether the client lists an extension at this major version (spec 3.3). */
export const supports = (
  metadata: ClientMetadata,
  name: string,
  version: string,
) => metadata.extensions?.[name]?.version === version;
