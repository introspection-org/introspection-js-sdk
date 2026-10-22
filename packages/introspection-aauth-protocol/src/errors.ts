import {
  generateAcceptSignatureSchemeHeader,
  generateSignatureErrorHeader,
  type SignatureErrorCode,
} from "@hellocoop/httpsig";

/** An AAuth error, answered as `application/problem+json`. */
export class AAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    detail: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(detail);
  }
}

/** A status other than an error's usual one, where AAuth gives the same code another. */
interface Answered {
  status?: number;
}

export class InvalidRequest extends AAuthError {
  constructor(detail: string, { status = 400 }: Answered = {}) {
    super(status, "invalid_request", detail);
  }
}

/** `400 invalid_<token>_token`, or `expired_<token>_token`, for a token the request carries. */
export class InvalidToken extends AAuthError {
  constructor(token: string, detail: string, { expired = false } = {}) {
    super(400, `${expired ? "expired" : "invalid"}_${token}_token`, detail);
  }
}

/** A pending URL that answered already, or never existed (#pending-url-security). */
export class InvalidCode extends AAuthError {
  constructor(detail: string) {
    super(410, "invalid_code", detail);
  }
}

export class Expired extends AAuthError {
  constructor(detail: string, { status = 408 }: Answered = {}) {
    super(status, "expired", detail);
  }
}

export class NotFound extends AAuthError {
  constructor(detail: string) {
    super(404, "not_found", detail);
  }
}

export class MissionNotFound extends AAuthError {
  constructor(detail = "no such mission") {
    super(404, "mission_not_found", detail);
  }
}

export class MissionTerminated extends AAuthError {
  constructor(detail: string, { status = 403 }: Answered = {}) {
    super(status, "mission_terminated", detail);
  }
}

export class AccessDenied extends AAuthError {
  constructor(detail: string) {
    super(403, "access_denied", detail);
  }
}

export class Denied extends AAuthError {
  constructor(detail: string) {
    super(403, "denied", detail);
  }
}

export class ServerError extends AAuthError {
  constructor(detail: string, { status = 500 }: Answered = {}) {
    super(status, "server_error", detail);
  }
}

/** `401`: the request's signature, or who signed it, is not accepted. */
export class Unauthorized extends AAuthError {
  constructor(error: string, detail: string, headers?: Record<string, string>) {
    super(401, error, detail, headers);
  }

  /** A signature or signing token that fails, with its `Signature-Error` (and, for a scheme, the one to use). */
  static signature(code: SignatureErrorCode, detail: string): Unauthorized {
    const headers: Record<string, string> = {
      "Signature-Error": generateSignatureErrorHeader({ error: code }),
    };
    if (code === "unsupported_scheme")
      headers["Accept-Signature-Scheme"] = generateAcceptSignatureSchemeHeader([
        "jwt",
      ]);
    return new Unauthorized(code, detail, headers);
  }
}

/** A problem response a host answers with, for a route of its own. */
export function problem(
  status: number,
  error: string,
  detail?: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error, ...(detail ? { detail } : {}) },
    {
      status,
      headers: { "Content-Type": "application/problem+json", ...headers },
    },
  );
}
