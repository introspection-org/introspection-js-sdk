import type {
  Member,
  MemberCreateParams,
  MemberListParams,
  MemberUpdateParams,
  Paginated,
  Uuid,
} from "@introspection-sdk/types";
import { encodeMetadataFilter } from "@introspection-sdk/http";
import type { HttpClient } from "../http.js";
import { Paginator, cursorPaginate } from "../pagination.js";

/**
 * List, read, create and update on `/v1/members` (Control Plane).
 * Removing a member is an org-admin action left to the CLI.
 *
 * `tags` are access-bearing and writable only with `members:manage`;
 * `metadata` is a `key: value` label map that grants nothing. Both are
 * replaced wholesale by {@link update}. A `customer` member's metadata is
 * also merged in by every identity assertion that names it
 * (`RunIdentityInput.metadata`).
 */
export class MembersApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * List members matching `params`. `await` the result for the first page,
   * or `for await` it to stream every member across pages (fetched lazily;
   * stop early to stop fetching).
   */
  list(params: MemberListParams = {}): Paginator<Member> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Member>>({
          method: "GET",
          path: "/v1/members",
          query: { ...encodeMetadataFilter(params), next } as Record<
            string,
            unknown
          >,
        }),
      params.next,
    );
  }

  /** Invite an operator by email; see {@link MemberCreateParams}. */
  create(params: MemberCreateParams): Promise<Member> {
    return this.http.request<Member>({
      method: "POST",
      path: "/v1/members",
      body: params,
    });
  }

  get(memberId: Uuid): Promise<Member> {
    return this.http.request<Member>({
      method: "GET",
      path: `/v1/members/${encodeURIComponent(memberId)}`,
    });
  }

  /**
   * Update a member. Only provided fields change; `tags` and `metadata`
   * each replace the stored value wholesale (`[]` / `{}` clear it).
   */
  update(memberId: Uuid, params: MemberUpdateParams): Promise<Member> {
    return this.http.request<Member>({
      method: "PATCH",
      path: `/v1/members/${encodeURIComponent(memberId)}`,
      body: params,
    });
  }
}

export function attachMembers(http: HttpClient): MembersApi {
  return new MembersApi(http);
}
