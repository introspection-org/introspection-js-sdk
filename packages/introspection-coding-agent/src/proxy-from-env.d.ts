declare module "proxy-from-env" {
  /**
   * Returns the forward-proxy URL that should handle a request to `url`, or an
   * empty string when no proxy is configured or the host matches `NO_PROXY`.
   */
  export function getProxyForUrl(url: string): string;
}
