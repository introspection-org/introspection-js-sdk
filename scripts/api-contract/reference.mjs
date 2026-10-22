/**
 * Where the API contract check and the drift report read one plane's
 * reference, so both always compare against the same document:
 * `--<plane> URL|PATH`, else the `API_CONTRACT_<PLANE>` environment variable,
 * else staging. `plane` is `dataplane` or `controlplane`.
 */
const STAGING = "https://api.staging.introspection.dev";

export function referenceSource(plane) {
  const flag = process.argv.indexOf(`--${plane}`);
  if (flag !== -1) return process.argv[flag + 1];
  return (
    process.env[`API_CONTRACT_${plane.toUpperCase()}`] ||
    `${STAGING}/openapi/${plane}.json`
  );
}
