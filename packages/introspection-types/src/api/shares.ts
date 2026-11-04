import type { CursorParams, IsoDate, Uuid } from "./common.js";

/** Resource families a share grant can target (tasks are not shareable). */
export type ShareResourceType = "file" | "conversation" | "issue";

/**
 * A sharing grant for a file, conversation or issue (`/v1/shares`).
 *
 * A share admits its grantee; the caller's token scopes decide whether they
 * may read, write or delete the resource. Shares apply ambiently: a shared
 * resource appears in the grantee's ordinary list and get reads.
 *
 * The grantee fields are ANDed: `granted_member_id` alone targets that member,
 * `granted_tag` alone targets everyone whose token carries the tag, both
 * target that member only while they hold the tag, and neither makes the
 * grant project-wide.
 */
export interface ResourceShare {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  resource_type: ShareResourceType;
  resource_id: string;
  /** Member the grant targets; `null` when it does not name one. */
  granted_member_id?: Uuid | null;
  /** Tag the grantee must hold (e.g. `team:acme`); `null` when untagged. */
  granted_tag?: string | null;
  /**
   * Conversation shares only: the grantee sees the conversation from this
   * instant onward. `null` shares its whole history.
   */
  visible_from?: IsoDate | null;
  /** Grantor (always a member) — the revoke gate. */
  created_by_member_id: Uuid;
  /**
   * Fully-qualified canonical GET URL for the shared resource
   * (`…/v1/files/{id}`, `…/v1/issues/{id}`, or
   * `…/v1/conversations/{id}/items`). It carries no capability: the share
   * applies to the grantee's ordinary reads.
   */
  url: string;
}

/**
 * Leave both `granted_member_id` and `granted_tag` unset for a project-wide
 * grant; see {@link ResourceShare} for how they combine. A tag share requires
 * the grantor to own the resource and hold the tag (or be an admin); a
 * duplicate live tag share is rejected with 409. An end customer is a member,
 * so there is no separate identity target.
 */
export interface ShareCreateParams {
  resource_type: ShareResourceType;
  resource_id: string;
  /** Target one member. */
  granted_member_id?: Uuid;
  /** Target everyone whose token carries this tag (e.g. `team:acme`). */
  granted_tag?: string;
  /**
   * Conversation shares only: expose the conversation from this instant
   * onward (RFC 3339, not in the future).
   */
  visible_from?: IsoDate;
}

/**
 * `PATCH /v1/shares/{id}` body. Only a conversation share's `visible_from`
 * can change; the grantee cannot. Only the grantor (or an admin) may update —
 * anyone else gets 404.
 */
export interface ShareUpdateParams {
  /**
   * Required. Not in the future, with a timezone (422 otherwise); `null`
   * clears it and shares the whole history.
   */
  visible_from: IsoDate | null;
}

export interface ShareListParams extends CursorParams {
  resource_type?: ShareResourceType;
  resource_id?: string;
  /** Only shares targeting this member. */
  granted_member_id?: Uuid;
  /** Only shares targeting this tag. */
  granted_tag?: string;
  /** Only shares the caller created. */
  created_by_me?: boolean;
  /**
   * Only shares targeting the caller, including tag shares whose tag the
   * caller holds.
   */
  granted_to_me?: boolean;
}
