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
