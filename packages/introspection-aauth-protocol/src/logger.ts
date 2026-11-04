/** A record's fields: identifiers and enumerated values, never a token, personal data or a body. */
export type LogFields = Record<string, string | number | undefined>;

/**
 * Where a server writes its decision records. The library configures no
 * logging: pass one that forwards to yours (structured, a field per value).
 * Unset, nothing is written.
 */
export interface AAuthLogger {
  info(message: string, fields: LogFields): void;
}

export const silent: AAuthLogger = { info: () => {} };
