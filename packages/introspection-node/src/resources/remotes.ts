import type { RemotesConnectDocs } from "@introspection-sdk/types";
import { ReadResource } from "./read-resource.js";

/**
 * `/v1/remotes` (Data Plane): the `introspection dev` remote connection. A
 * developer's machine dials the WebSocket at `/v1/remotes/connect` and serves
 * its local MCP servers and Recipe edits to one Runtime's development tasks.
 *
 * The socket needs a login token carrying `remotes:connect`, which only a
 * development login (`introspection login`, see {@link DeviceCodeAuth}) holds.
 * Its frames are protobuf `Frame` messages whose schema the CLI owns; this
 * namespace reads the route's protocol description.
 */
export class RemotesApi extends ReadResource {
  /**
   * The WebSocket's protocol: authentication, handshake, schema version and
   * frame catalogue. WebSocket routes are not expressible in OpenAPI, so the
   * Data Plane answers a plain `GET` on the same path with this.
   */
  connectDocs(): Promise<RemotesConnectDocs> {
    return this.read<RemotesConnectDocs>("/v1/remotes/connect");
  }
}
