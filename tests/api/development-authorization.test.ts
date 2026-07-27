import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readDevelopmentAuthorization } from "../../packages/introspection-node/src/development-authorization";

describe("readDevelopmentAuthorization", () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), "introspection-development-authorization-"),
    );
    path = join(directory, "token.json");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("INTROSPECTION_DEVELOPMENT_TOKEN_FILE", path);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  async function writeToken(
    overrides: Partial<{
      version: number;
      access_token: string;
      expires_at: string;
    }> = {},
  ) {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        access_token: "development-proof",
        expires_at: new Date(Date.now() + 120_000).toISOString(),
        ...overrides,
      }),
      { mode: 0o600 },
    );
    await chmod(path, 0o600);
  }

  it("returns undefined when no token file is configured", () => {
    vi.stubEnv("INTROSPECTION_DEVELOPMENT_TOKEN_FILE", "");
    vi.stubEnv("HOME", directory);
    expect(readDevelopmentAuthorization()).toBeUndefined();
  });

  it("reads the shared default path without application configuration", async () => {
    vi.stubEnv("INTROSPECTION_DEVELOPMENT_TOKEN_FILE", "");
    vi.stubEnv("HOME", directory);
    path = join(directory, ".introspection", "development.json");
    await mkdir(join(directory, ".introspection"));
    await writeToken();
    expect(readDevelopmentAuthorization()).toBe("development-proof");
  });

  it("allows ordinary local Node processes without NODE_ENV", async () => {
    await writeToken();
    vi.stubEnv("NODE_ENV", "");
    expect(readDevelopmentAuthorization()).toBe("development-proof");
  });

  it("reads a current private versioned token file", async () => {
    await writeToken();
    expect(readDevelopmentAuthorization()).toBe("development-proof");
  });

  it("rejects a configured proof outside local development", async () => {
    await writeToken();
    vi.stubEnv("NODE_ENV", "production");
    expect(() => readDevelopmentAuthorization()).toThrow(
      "introspection_development_authorization_not_local",
    );
  });

  it("rejects expired and near-expiry proofs", async () => {
    await writeToken({
      expires_at: new Date(Date.now() + 5_000).toISOString(),
    });
    expect(() => readDevelopmentAuthorization()).toThrow(
      "introspection_development_authorization_expired",
    );
  });

  it("rejects malformed proof files", async () => {
    await writeFile(path, "not-json", { mode: 0o600 });
    expect(() => readDevelopmentAuthorization()).toThrow(
      "introspection_development_authorization_invalid",
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects group- or world-readable proof files",
    async () => {
      await writeToken();
      await chmod(path, 0o644);
      expect(() => readDevelopmentAuthorization()).toThrow(
        "introspection_development_authorization_unsafe_permissions",
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not follow a token-file symlink",
    async () => {
      const target = join(directory, "target.json");
      await writeFile(
        target,
        JSON.stringify({
          version: 1,
          access_token: "development-proof",
          expires_at: new Date(Date.now() + 120_000).toISOString(),
        }),
        { mode: 0o600 },
      );
      await symlink(target, path);
      expect(() => readDevelopmentAuthorization()).toThrow(
        "introspection_development_authorization_unsafe_file",
      );
    },
  );
});
