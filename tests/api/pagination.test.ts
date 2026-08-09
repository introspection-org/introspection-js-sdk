/**
 * `cursorPaginate` termination.
 *
 * Both cases here were infinite loops: a `for await` that never ends and
 * re-yields the same records forever, against a server that is behaving
 * within the envelope's contract.
 */
import { describe, expect, it } from "vitest";
import { cursorPaginate } from "@introspection-sdk/http";
import type { Paginated } from "@introspection-sdk/types";

function page(records: string[], next: string | null): Paginated<string> {
  return { records, next } as Paginated<string>;
}

/** Collect at most `cap` items, so a non-terminating paginator fails loudly. */
async function drain(
  it: AsyncIterable<string>,
  cap = 50,
): Promise<{ items: string[]; hitCap: boolean }> {
  const items: string[] = [];
  for await (const item of it) {
    items.push(item);
    if (items.length >= cap) return { items, hitCap: true };
  }
  return { items, hitCap: false };
}

describe("cursorPaginate stops when the cursor stops moving", () => {
  it("pages through and terminates on a null cursor", async () => {
    const pages = [page(["a", "b"], "c1"), page(["c"], null)];
    let calls = 0;
    const listing = cursorPaginate<string>(async () => pages[calls++]!);
    const { items, hitCap } = await drain(listing);
    expect(hitCap).toBe(false);
    expect(items).toEqual(["a", "b", "c"]);
    expect(calls).toBe(2);
  });

  it("treats an empty-string cursor as exhaustion, not as another page", async () => {
    // `next: ""` is not nullish, so `page.next ?? undefined` handed it back
    // as a real cursor and the first page was refetched forever.
    let calls = 0;
    const listing = cursorPaginate<string>(async () => {
      calls++;
      return page(["a"], "");
    });
    const { items, hitCap } = await drain(listing);
    expect(hitCap).toBe(false);
    expect(items).toEqual(["a"]);
    expect(calls).toBe(1);
  });

  it("stops when the server echoes back the cursor it was given", async () => {
    let calls = 0;
    const listing = cursorPaginate<string>(async (cursor) => {
      calls++;
      return cursor === undefined ? page(["a"], "c1") : page(["b"], "c1");
    });
    const { items, hitCap } = await drain(listing);
    expect(hitCap).toBe(false);
    expect(items).toEqual(["a", "b"]);
    expect(calls).toBe(2);
  });

  it("still resolves the first page as a thenable", async () => {
    const listing = cursorPaginate<string>(async () => page(["a"], "c1"));
    await expect(listing).resolves.toEqual({ records: ["a"], next: "c1" });
  });
});
