import { expectTypeOf, it } from "vitest";
import type {
  ConnectorAuthorizeParams,
  ConnectorApp,
  ConnectorAccountListResponse,
  ConnectorsApi,
} from "@introspection-sdk/introspection-node";

// Compile-time API contract only. No HTTP transport or framework is mocked.
it("accepts Pipedream consent parameters through the public API", () => {
  const params = {
    app: "microsoft_outlook",
    runtime: "north",
    identity: { user_id: "customer-123" },
    allow_progressive_scopes: false,
    return_url: "https://north.example/settings",
  } satisfies ConnectorAuthorizeParams;
  expectTypeOf(params).toExtend<
    NonNullable<Parameters<ConnectorsApi["authorize"]>[1]>
  >();
  expectTypeOf<ConnectorAuthorizeParams["app"]>().toEqualTypeOf<
    string | undefined
  >();
  expectTypeOf<
    ConnectorAuthorizeParams["allow_progressive_scopes"]
  >().toEqualTypeOf<boolean | undefined>();
});

it("exposes the provider catalogue without pretending it is cursor paginated", () => {
  expectTypeOf<ReturnType<ConnectorsApi["listApps"]>>().toEqualTypeOf<
    Promise<ConnectorApp[]>
  >();
  expectTypeOf<Parameters<ConnectorsApi["listApps"]>[1]>().toEqualTypeOf<
    { q?: string; limit?: number } | undefined
  >();
});

it("exposes customer-scoped provider accounts", () => {
  expectTypeOf<ReturnType<ConnectorsApi["listAccounts"]>>().toEqualTypeOf<
    Promise<ConnectorAccountListResponse>
  >();
  expectTypeOf<Parameters<ConnectorsApi["listAccounts"]>[1]>().toEqualTypeOf<
    { identity_user_id?: string; runtime?: string } | undefined
  >();
});
