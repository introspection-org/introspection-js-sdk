import { Paginated } from "@introspection-sdk/types";

/**
 * Adapts a wire pagination protocol for {@link Paginator}: how to fetch
 * a page at a given cursor, pull the items out of it, and find the
 * cursor for the next page (`undefined` once the list is exhausted).
 */
export interface PageSource<T, TPage> {
  /** Fetch the page at `cursor` (`undefined` = the first page). */
  fetch(cursor: string | undefined): Promise<TPage>;
  /** Items contained in `page`, in iteration order. */
  items(page: TPage): T[];
  /** Cursor for the page after `page`, or `undefined` when exhausted. */
  next(page: TPage): string | undefined;
}

/**
 * A lazy, auto-paging collection.
 *
 * - `await listing` resolves to the FIRST page, preserving the wire
 *   envelope's metadata (counts, `has_more`, …).
 * - `for await (const item of listing)` streams every item across all
 *   pages, fetching each page only as the iterator reaches it; stop
 *   early to stop fetching.
 */
export class Paginator<T, TPage = Paginated<T>>
  implements AsyncIterable<T>, PromiseLike<TPage>
{
  constructor(
    private readonly source: PageSource<T, TPage>,
    private readonly start?: string,
  ) {}

  /** Thenable: resolves to the first page (no further pages fetched). */
  then<R1 = TPage, R2 = never>(
    onfulfilled?: ((page: TPage) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.source.fetch(this.start).then(onfulfilled, onrejected);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let cursor = this.start;
    do {
      const page = await this.source.fetch(cursor);
      for (const item of this.source.items(page)) yield item;
      cursor = this.source.next(page);
    } while (cursor !== undefined);
  }
}

/**
 * Build a {@link Paginator} over the standard Introspection cursor
 * envelope ({@link Paginated}): items live in `records` and the next
 * page is reached via the opaque `next` token.
 */
export function cursorPaginate<T>(
  fetch: (next: string | undefined) => Promise<Paginated<T>>,
  start?: string,
): Paginator<T, Paginated<T>> {
  return new Paginator(
    {
      fetch,
      items: (page) => page.records,
      next: (page) => page.next ?? undefined,
    },
    start,
  );
}
