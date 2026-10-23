import { ServerError } from "./errors.js";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/**
 * `fetch` for every outbound AAuth call: metadata, keys, R3 proposals and the
 * token requests that carry tokens. AAuth servers are `https` origins, so a
 * plain-`http` URL is refused before anything is sent, and a redirect is never
 * followed, so a server cannot downgrade or move a request after the URL was
 * checked.
 */
export function httpsOnly(fetch: FetchLike): FetchLike {
  return (input, init) => {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return Promise.reject(
        new ServerError(`${input} is not a URL`, { status: 502 }),
      );
    }
    if (url.protocol !== "https:")
      return Promise.reject(
        new ServerError(
          `${url.origin} is not https; AAuth calls only https servers`,
          { status: 502 },
        ),
      );
    return fetch(input, { ...init, redirect: "error" });
  };
}
