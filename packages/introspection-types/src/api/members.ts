import type { CursorParams, IsoDate, Uuid } from "./common.js";

/** What kind of principal a member row is. */
export type MemberType = "business" | "agent" | "customer";

/**
 * An org member (`/v1/members`, Control Plane): an operator (`business`),
 * a built-in or application agent (`agent`), or a federated end user
 * (`customer`, minted from an asserted {@link RunIdentityInput}).
 */
export interface Member {
  id: Uuid;
  org_id: Uuid;
  email?: string | null;
  name?: string | null;
  /** The IdP subject, or a `customer`'s tier-prefixed key (`user:abc`). */
  external_user_id?: string | null;
  image_url?: string | null;
  /** `owner`, `admin` or `member`; a built-in agent's role is its name. */
  role: string;
  member_type: MemberType;
  is_deactivated: boolean;
  /**
   * Access-bearing tags: this member receives every tag share
   * (`granted_tag`) naming one of them. It can also still read and write any
   * file or task whose tags intersect these, but that implicit access is
   * deprecated in favour of tag shares. Writable only with `members:manage`.
   */
  tags: string[];
  /**
   * Customer-defined `key: value` labels. Grants nothing: unlike `tags`,
   * metadata is on no authorization path. Absent from servers that predate
   * it.
   */
  metadata?: Record<string, string>;
  /**
   * Attributes the recipe's Cedar policies read for this member as a
   * principal (e.g. `{ level: 6 }`); see {@link PolicyEntity}.
   */
  policy_attributes?: Record<string, unknown> | null;
  application_idp_id?: Uuid | null;
  connector_id?: Uuid | null;
  integration_id?: Uuid | null;
  /** Whether this is a fixed agent that may back an external credential. */
  is_external_credential_agent?: boolean;
  created_at: IsoDate;
  updated_at: IsoDate;
  deleted_at?: IsoDate | null;
}

export interface MemberListParams extends CursorParams {
  /** Project context, for deployment-authenticated callers. */
  project?: Uuid;
  member_type?: MemberType;
  /** `customer` members a connector's verified delivery minted. */
  connector_id?: Uuid;
  /** `customer` members a brokered IdP federated in. */
  application_idp_id?: Uuid;
  /**
   * Filter by one tag, e.g. `customer:acme`. Tags are access-bearing, so
   * this answers "who can reach the rows tagged `customer:acme`".
   */
  tag?: string;
  /**
   * Filter: members whose `metadata` holds each of these pairs, matched
   * exactly against the string value. Sent as one repeated
   * `metadata=key:value` param per entry; entries are ANDed, at most 16.
   *
   * ```ts
   * client.members.list({ metadata: { plan: "enterprise" } });
   * ```
   *
   * Keys are `[A-Za-z0-9_-]` with no `.`; values may contain colons and
   * must not be empty. A malformed pair is a 422. Narrows only, like `tag`.
   */
  metadata?: Record<string, string>;
  /** Resolve these member ids. Unions with `external_user_id`. */
  id?: Uuid[];
  /** Resolve these tier-prefixed keys (`user:abc`). Unions with `id`. */
  external_user_id?: string[];
}

/** Fields every `POST /v1/members` body may carry, whatever its kind. */
interface MemberCreateCommon {
  /**
   * Seed the member's access-bearing tags. Setting any needs
   * `members:manage` as well (a 403 otherwise), the same gate as
   * {@link MemberUpdateParams.tags}.
   */
  tags?: string[];
  /**
   * Seed the member's metadata. Keys are `[A-Za-z0-9_-]+` (at most 128
   * characters, no `.`); values are non-empty strings of at most 1024
   * characters; at most 64 entries. Out of bounds is a 422.
   */
  metadata?: Record<string, string>;
  /**
   * Seed the attributes Cedar policies read for this member; see
   * {@link Member.policy_attributes}. Setting them needs an org owner.
   */
  policy_attributes?: Record<string, unknown>;
}

/**
 * A business member: an operator invited by email. Requires an admin
 * credential with `members:write`, a full (first and last) `name`, and an
 * `email` not already a member elsewhere. The default when `member_type`
 * is omitted.
 */
export interface BusinessMemberCreateParams extends MemberCreateCommon {
  member_type?: "business";
  email: string;
  name: string;
  /** `member` (default), `admin` or `owner`, bounded by the caller's role. */
  role?: string;
}

/**
 * A customer member: one of the organization's own end users, keyed by its
 * id for them. It lands on the same member a runner identity asserting this
 * `external_user_id` would mint, so its attributes are ready before its
 * first session. Needs an org owner.
 */
export interface CustomerMemberCreateParams extends MemberCreateCommon {
  member_type: "customer";
  /** `user:{id}` or `anon:{id}`, as a runner identity asserts it. */
  external_user_id: string;
  /** Display only. */
  name?: string;
  /** Display only; a customer never signs in. */
  email?: string;
}

/** `POST /v1/members` body, narrowed on `member_type`. */
export type MemberCreateParams =
  BusinessMemberCreateParams | CustomerMemberCreateParams;

/** `PATCH /v1/members/{id}` — needs `members:manage`. */
export interface MemberUpdateParams {
  name?: string;
  image_url?: string;
  role?: string;
  /**
   * Replaces the tag list wholesale. Omit to leave tags untouched; pass
   * `[]` to clear them. Adding a tag grants this member every file and
   * task carrying it.
   */
  tags?: string[];
  /**
   * Replaces the metadata map wholesale (it is not merged). Omit, or pass
   * `null`, to leave it untouched; pass `{}` to clear it. Same bounds as
   * {@link BusinessMemberCreateParams.metadata}.
   */
  metadata?: Record<string, string> | null;
  /**
   * Replaces the Cedar policy attributes wholesale. Omit to leave them
   * untouched. Setting them needs an org owner.
   */
  policy_attributes?: Record<string, unknown>;
}
