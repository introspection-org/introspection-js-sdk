import type {
  Member,
  MemberCreateParams,
  MemberListParams,
  MemberUpdateParams,
  Uuid,
} from "@introspection-sdk/types";
import { encodeMetadataFilter } from "@introspection-sdk/http";
import type { HttpClient } from "../http.js";
import { Paginator, paginateGet } from "../pagination.js";

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
    return paginateGet<Member>(
      this.http,
      "/v1/members",
      encodeMetadataFilter(params),
      params.next,
    );
  }

  /**
   * Invite a business member by email, or create a customer member keyed
   * by `external_user_id`; see {@link MemberCreateParams}.
   */
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
