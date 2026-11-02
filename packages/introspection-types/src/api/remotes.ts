/** How a WebSocket route authenticates. */
export interface WsAuthenticationDocs {
  method: string;
  description: string;
  example: string;
}

/** One frame of the remote protocol: its field name in the protobuf `Frame.body` oneof. */
export interface WsFrameDocs {
  frame: string;
  description: string;
}

/** The frames each side of the remote connection sends. */
export interface WsMessageProtocolDocs {
  remote_to_cloud: WsFrameDocs[];
  cloud_to_remote: WsFrameDocs[];
}

/**
 * `GET /v1/remotes/connect` response: the remote connection's protocol.
 * WebSocket routes are not expressible in OpenAPI, so the Data Plane
 * documents the socket on a `GET` of the same path.
 */
export interface RemotesConnectDocs {
  /** The socket's path, `/v1/remotes/connect`. */
  endpoint: string;
  /** Which schemes the socket takes, and where. */
  protocol: string;
  authentication: WsAuthenticationDocs;
  /** The handshake, step by step, in order. */
  handshake: string[];
  /** The `remote.proto` schema version the server speaks. */
  schema_version: number;
  /** How a frame is carried in a WebSocket message. */
  encoding: string;
  message_protocol: WsMessageProtocolDocs;
}
