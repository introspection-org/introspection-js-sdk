/** Version information for the coding-agent capture package. */
export const VERSION = "0.29.0"; // x-release-please-version

/**
 * `service.name` stamped on every span this package exports.
 *
 * Fixed rather than configurable: it is the discriminator the platform uses to
 * tell plugin-sourced telemetry apart from customer SDK traffic, so a caller
 * must not be able to rename it into another service's namespace.
 */
export const SERVICE_NAME = "introspection-plugin";
