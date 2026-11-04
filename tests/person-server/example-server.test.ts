/** The example server's flag and environment parsing. */
import { describe, expect, it } from "vitest";

import { parse } from "../../packages/introspection-aauth-person-server/examples/server";

describe("example server parse", () => {
  it("defaults", () => {
    expect(parse([], {})).toEqual({
      issuer: "https://ps.example",
      trusted: ["https://api.introspection.dev"],
      addr: "127.0.0.1:3400",
      host: "127.0.0.1",
      port: 3400,
      basePath: "",
      approver: undefined,
      defaultTenant: undefined,
      requireTenant: false,
      signingKey: undefined,
      subjectSecret: undefined,
      adminToken: undefined,
    });
  });

  it("takes the environment over the defaults", () => {
    const options = parse([], {
      PS_ISSUER: "https://ps.acme.example",
      PS_TRUSTED: "https://a.example, https://b.example",
      PS_ADDR: "[::1]:8080",
      PS_APPROVER: "dana@acme.example",
      PS_REQUIRE_TENANT: "true",
      PS_ADMIN_TOKEN: "secret",
    });
    expect(options).toMatchObject({
      issuer: "https://ps.acme.example",
      trusted: ["https://a.example", "https://b.example"],
      host: "::1",
      port: 8080,
      approver: "dana@acme.example",
      requireTenant: true,
      adminToken: "secret",
    });
  });

  it("takes flags over the environment", () => {
    const options = parse(
      ["--issuer", "https://flag.example", "--default-tenant", "acme"],
      { PS_ISSUER: "https://env.example", PS_DEFAULT_TENANT: "other" },
    );
    expect(options).toMatchObject({
      issuer: "https://flag.example",
      defaultTenant: "acme",
    });
  });

  it("answers help", () => {
    expect(parse(["-h"], {})).toBe("help");
  });

  it("refuses --require-tenant with --default-tenant", () => {
    expect(() =>
      parse(["--require-tenant", "--default-tenant", "acme"], {}),
    ).toThrow(/conflict/);
  });

  it("refuses an unknown flag, a positional and a bad value", () => {
    expect(() => parse(["--signing-key", "pem"], {})).toThrow(/Unknown option/);
    expect(() => parse(["extra"], {})).toThrow();
    expect(() => parse(["--addr", "3400"], {})).toThrow(/--addr/);
  });
});
