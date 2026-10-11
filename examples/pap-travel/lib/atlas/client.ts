/**
 * Atlas as a PAP client: its identity (a Client ID Metadata Document and the
 * keys behind it), its assertions, and DPoP-signed calls to a Company. Every
 * call is recorded, with credentials shortened, for the page to show.
 */
import "server-only";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { newKeyPair, proof, type KeyPair } from "../dpop";
import { once } from "../once";
import { ATLAS_URL } from "../origins";

export const CLIENT_ID = `${ATLAS_URL}/agent.json`;
export const REDIRECT_URI = `${ATLAS_URL}/oauth/callback`;
const KID = "atlas-1";

const identity = once("atlas_identity", async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  return {
    privateKey,
    publicJwk: {
      ...(await exportJWK(publicKey)),
      kid: KID,
      alg: "ES256",
      use: "sig",
    },
  };
});

export function clientMetadata() {
  return {
    client_id: CLIENT_ID,
    client_name: "Atlas",
    jwks_uri: `${ATLAS_URL}/jwks.json`,
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: "private_key_jwt",
  };
}

export async function jwks() {
  return { keys: [(await identity).publicJwk] };
}

/** A short-lived JWT signed with Atlas's published key: its client assertion, or a Session assertion naming the User. */
export async function assertion(audience: string, subject = CLIENT_ID) {
  return new SignJWT({ jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuer(CLIENT_ID)
    .setSubject(subject)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign((await identity).privateKey);
}

export type Exchange = {
  id: string;
  label: string;
  request: string;
  response: string;
};

const SECRET_FIELDS = [
  "assertion",
  "client_assertion",
  "refresh_token",
  "access_token",
  "code",
  "code_verifier",
  "token",
];
const short = (value: string) =>
  value.length > 14 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value;

function shortenForm(body: string) {
  const form = new URLSearchParams(body);
  return [...form]
    .map(
      ([k, v]) =>
        `${k}=${SECRET_FIELDS.includes(k) ? short(v) : encodeURIComponent(v)}`,
    )
    .join("\n&");
}

function shortenJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shortenJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_FIELDS.includes(k) && typeof v === "string"
          ? short(v)
          : shortenJson(v),
      ]),
    );
  return value;
}

export type Call = {
  label: string;
  method: "GET" | "POST";
  url: string;
  form?: Record<string, string>;
  json?: unknown;
  /** The Session Token and the key it is bound to; a token request sends a proof with no token. */
  dpop?: { key: KeyPair; token?: string };
};

export type Recorder = (exchange: Exchange) => void;

/** One HTTP call, retried once with the Company's DPoP nonce if it asks for one. */
export type Answer = {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
};

export async function call(
  record: Recorder,
  spec: Call,
  nonce?: string,
): Promise<Answer> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (spec.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(spec.form).toString();
  } else if (spec.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(spec.json);
  }
  if (spec.dpop) {
    if (spec.dpop.token) headers.Authorization = `DPoP ${spec.dpop.token}`;
    headers.DPoP = await proof(spec.dpop.key, spec.method, spec.url, {
      token: spec.dpop.token,
      nonce,
    });
  }
  const response = await fetch(spec.url, {
    method: spec.method,
    headers,
    body,
    cache: "no-store",
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }

  const shown = (name: string, value: string) =>
    name === "Authorization"
      ? `DPoP ${short(value.slice(5))}`
      : name === "DPoP"
        ? short(value)
        : value;
  const requestText = [
    `${spec.method} ${spec.url}`,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${shown(k, v)}`),
    ...(body
      ? [
          "",
          spec.form
            ? shortenForm(body)
            : JSON.stringify(shortenJson(spec.json), null, 2),
        ]
      : []),
  ].join("\n");
  const wwwAuth = response.headers.get("www-authenticate");
  const responseText = [
    `HTTP/1.1 ${response.status} ${response.statusText}`,
    ...(wwwAuth ? [`WWW-Authenticate: ${wwwAuth}`] : []),
    ...(parsed !== null && parsed !== ""
      ? [
          "",
          typeof parsed === "string"
            ? parsed
            : JSON.stringify(shortenJson(parsed), null, 2),
        ]
      : []),
  ].join("\n");
  record({
    id: crypto.randomUUID(),
    label: spec.label,
    request: requestText,
    response: responseText,
  });

  const asked = response.headers.get("dpop-nonce");
  if (
    !nonce &&
    asked &&
    (parsed as { error?: string })?.error === "use_dpop_nonce"
  )
    return call(record, spec, asked);
  const json =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  return { status: response.status, body: json, headers: response.headers };
}

export { newKeyPair, type KeyPair };
