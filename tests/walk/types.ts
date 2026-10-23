/**
 * Response shapes of the documented routes the SDK is exempt from today, as
 * the walk reads them. Only the fields the walk asserts on are typed; the
 * inline snapshots pin the rest.
 */

export interface Integration {
  id: string;
  type: string;
  status: string;
}

export interface Paginated<T> {
  records: T[];
  next?: string | null;
}
