/**
 * The Person Server's client for a resource's own Access Server (draft -11
 * #access-server-federation): it discovers the Access Server, redeems a
 * resource token there signed as the Person Server (#ps-to-as-token-request),
 * polls while it decides (#deferred-responses), and checks the auth token it
 * delivers (#auth-token-delivery). `PersonServer` drives it.
 */
import { fetch as signedFetch } from "@hellocoop/httpsig";
import { type Span, trace } from "@opentelemetry/api";
import {
  APPROVAL_REQUIREMENT,
  type FetchLike,
  isJsonObject,
  onOrigin,
  requirementName,
  retryAfter,
  type Signer,
  trimIdentifier,
} from "@introspection-sdk/aauth-protocol";

import { checkDelivered, type Delivery } from "./delivery.js";
import { type Federation, Outcome } from "./types.js";

const tracer = trace.getTracer("@introspection-sdk/aauth-person-server");

const ACCESS_DWK = "aauth-access.json";
/** Requirements an Access Server may wait on that this Person Server relays to the agent. */
const SERVED = new Set(["approval", "interaction"]);
/** Requirements it would answer for the person, which it does not yet. */
const NOT_SERVED = new Set(["claims", "clarification"]);

/** An Access Server's metadata, once it names the Access Server and keeps its endpoints on its origin. */
export interface AccessMetadata {
  issuer: string;
  jwks_uri: string;
  auth_token_endpoint: string;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** A string member of a JSON object, or undefined. */
function member(body: unknown, name: string): string | undefined {
  const value = isJsonObject(body) ? body[name] : undefined;
  return typeof value === "string" ? value : undefined;
}

const retrying = (response: Response) => {
  const seconds = retryAfter(response.headers);
  return seconds === undefined ? {} : { retry_after: seconds };
};

/** Run `exchange` in a span named for it, with the Access Server it talks to. */
const traced = <T>(
  name: string,
  accessServer: string,
  exchange: () => Promise<T>,
): Promise<T> =>
  tracer.startActiveSpan(
    `person_server.federate.${name}`,
    { attributes: { "aauth.access_server": accessServer } },
    (span: Span) => exchange().finally(() => span.end()),
  );

export class AccessServerClient {
  /** Signs as `issuer` with `signer` (`sig=jwks_uri` under its `aauth-person.json`). */
  constructor(
    private readonly issuer: string,
    private readonly signer: Signer,
    private readonly fetch: FetchLike,
    private readonly now: () => number,
  ) {}

  /** `{aud}/.well-known/aauth-access.json`, whose `issuer` is the `aud`. */
  discover(accessServer: string): Promise<AccessMetadata | Outcome> {
    return traced("metadata", accessServer, async () => {
      const url = `${accessServer}/.well-known/${ACCESS_DWK}`;
      let response: Response;
      try {
        response = await this.fetch(url);
      } catch (err) {
        return Outcome.unreachable(`${url}: ${(err as Error).message}`);
      }
      if (!response.ok)
        return Outcome.unreachable(`${url} answered ${response.status}`);
      const doc = await readJson(response);
      const issuer = member(doc, "issuer");
      const jwks_uri = member(doc, "jwks_uri");
      const auth_token_endpoint = member(doc, "auth_token_endpoint");
      if (
        issuer === undefined ||
        trimIdentifier(issuer) !== trimIdentifier(accessServer) ||
        jwks_uri === undefined ||
        !onOrigin(jwks_uri, accessServer) ||
        auth_token_endpoint === undefined ||
        !onOrigin(auth_token_endpoint, accessServer)
      )
        return Outcome.unreachable(
          `${url} is not this Access Server's metadata, with endpoints on its own https origin`,
        );
      return { issuer: accessServer, jwks_uri, auth_token_endpoint };
    });
  }

  /** The token request, with the budget the Person Server allows. */
  request(
    federation: Federation,
    agentJkt: string,
    metadata: AccessMetadata,
  ): Promise<Outcome> {
    return traced("request", metadata.issuer, async () => {
      const url = metadata.auth_token_endpoint;
      const body = JSON.stringify({
        resource_token: federation.resource_token,
        agent_token: federation.agent_token,
        presented_token: federation.presented_token,
        ...(federation.budget ? { budget: federation.budget } : {}),
      });
      const response = await this.send(url, body);
      return response instanceof Outcome
        ? response
        : this.outcome(response, url, federation, { agentJkt, metadata });
    });
  }

  /** `GET` the Access Server's pending URL, signed as the request was. */
  poll(
    location: string,
    federation: Federation,
    agentJkt: string,
    metadata: AccessMetadata,
  ): Promise<Outcome> {
    return traced("poll", metadata.issuer, async () => {
      const response = await this.send(location);
      return response instanceof Outcome
        ? response
        : this.outcome(response, location, federation, { agentJkt, metadata });
    });
  }

  /** A request signed with this Person Server's key, `sig=jwks_uri`; unreachable when it cannot be sent. */
  private async send(url: string, body?: string): Promise<Response | Outcome> {
    const method = body === undefined ? "GET" : "POST";
    const { headers } = await signedFetch(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            body,
            headers: { "Content-Type": "application/json" },
            contentDigest: "require" as const,
          }),
      signingKey: this.signer.privateJwk as JsonWebKey,
      signatureKey: {
        type: "jwks_uri",
        id: this.issuer,
        kid: this.signer.kid,
        dwk: "aauth-person.json",
      },
      dryRun: true,
    });
    try {
      return await this.fetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      });
    } catch (err) {
      return Outcome.unreachable(`${url}: ${(err as Error).message}`);
    }
  }

  /** Act on the Access Server's answer: an auth token, a wait, or a refusal relayed with its reason. */
  private async outcome(
    response: Response,
    requested: string,
    federation: Federation,
    delivery: Pick<Delivery, "agentJkt" | "metadata">,
  ): Promise<Outcome> {
    if (response.status === 200) {
      const auth_token = member(await readJson(response), "auth_token");
      if (auth_token === undefined)
        return Outcome.unreachable("it answered 200 without an auth_token");
      return traced("delivery", delivery.metadata.issuer, () =>
        checkDelivered(auth_token, {
          ...delivery,
          federation,
          ps: this.issuer,
          fetch: this.fetch,
          now: this.now(),
        }),
      );
    }
    if (response.status === 202) return this.waiting(response, requested);
    if (response.status === 402)
      return Outcome.refused(
        403,
        "denied",
        "the Access Server asks for payment, which this Person Server does not make",
      );
    // #deferred-responses: a busy AS is asked again later, at the same Location or with the same request.
    if (response.status === 429 || response.status === 503)
      return new Outcome("pending", {
        ...(requested === federation.location ? { location: requested } : {}),
        requirement: federation.requirement ?? APPROVAL_REQUIREMENT,
        ...retrying(response),
      });
    const body = await readJson(response);
    const error = member(body, "error");
    if (response.status >= 400 && response.status < 500 && error !== undefined)
      return Outcome.refused(
        response.status,
        error,
        `the Access Server refused: ${member(body, "detail") ?? error}`,
      );
    return Outcome.unreachable(`it answered ${response.status}`);
  }

  /** A `202`: where to poll, and the requirement to relay while it decides. */
  private waiting(response: Response, requested: string): Outcome {
    const header = response.headers.get("aauth-requirement");
    const requirement = header ? requirementName(header) : "approval";
    if (requirement === undefined)
      return Outcome.unreachable("its AAuth-Requirement is malformed");
    if (NOT_SERVED.has(requirement))
      return Outcome.refused(
        403,
        "denied",
        `the Access Server asks for requirement=${requirement}, not served here yet`,
      );
    const location = response.headers.get("location");
    const polled = location ? new URL(location, requested).href : undefined;
    if (!polled || !onOrigin(polled, requested))
      return Outcome.unreachable(
        "its pending Location is not on its own origin",
      );
    return new Outcome("pending", {
      location: polled,
      // An unrecognised requirement is polled through, and relayed as approval (#requirement-values).
      requirement:
        header && SERVED.has(requirement) ? header : APPROVAL_REQUIREMENT,
      ...retrying(response),
    });
  }
}
