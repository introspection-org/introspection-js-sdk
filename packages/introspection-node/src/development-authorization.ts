import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";

const TOKEN_EXPIRY_SKEW_MS = 30_000;

type DevelopmentAuthorizationFile = {
  version: number;
  access_token: string;
  expires_at: string;
};

export class DevelopmentAuthorizationError extends Error {}

export function readDevelopmentAuthorization(): string | undefined {
  const path = process.env.INTROSPECTION_DEVELOPMENT_TOKEN_FILE?.trim();
  if (!path) return undefined;
  if (process.env.NODE_ENV !== "development") {
    throw new DevelopmentAuthorizationError(
      "introspection_development_authorization_not_local",
    );
  }

  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new DevelopmentAuthorizationError(
        "introspection_development_authorization_unsafe_file",
      );
    }
    throw new DevelopmentAuthorizationError(
      "introspection_development_authorization_unavailable",
    );
  }

  let raw: string;
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new DevelopmentAuthorizationError(
        "introspection_development_authorization_unsafe_file",
      );
    }
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      throw new DevelopmentAuthorizationError(
        "introspection_development_authorization_unsafe_permissions",
      );
    }
    raw = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }

  let document: DevelopmentAuthorizationFile;
  try {
    document = JSON.parse(raw) as DevelopmentAuthorizationFile;
  } catch {
    throw new DevelopmentAuthorizationError(
      "introspection_development_authorization_invalid",
    );
  }

  const expiresAt = Date.parse(document.expires_at);
  if (
    document.version !== 1 ||
    typeof document.access_token !== "string" ||
    !document.access_token.trim() ||
    !Number.isFinite(expiresAt)
  ) {
    throw new DevelopmentAuthorizationError(
      "introspection_development_authorization_invalid",
    );
  }
  if (expiresAt <= Date.now() + TOKEN_EXPIRY_SKEW_MS) {
    throw new DevelopmentAuthorizationError(
      "introspection_development_authorization_expired",
    );
  }
  return document.access_token.trim();
}
