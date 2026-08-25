import { randomBytes } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type Paginated,
  type ProjectLabel,
  type ProjectLabelCreate,
  type ProjectLabelListParams,
  type ProjectLabelUpdate,
  type ReviewListParams,
  type ReviewEventOptions,
  type ReviewMutation,
  type ReviewState,
  type ReviewTarget,
  type Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, cursorPaginate } from "../pagination.js";

interface ReviewMember {
  id: Uuid;
  email: string | null;
  is_deactivated: boolean;
}

function clientValidationError(message: string, code: string): ValidationError {
  return new ValidationError({
    message,
    status: 422,
    code,
    body: null,
  });
}

/** Mint a time-ordered UUIDv7 without adding a runtime dependency. */
function reviewEventId(now = Date.now()): Uuid {
  const bytes = Buffer.allocUnsafe(16);
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  randomBytes(10).copy(bytes, 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizedEmails(emails: string | readonly string[]): string[] {
  const values = typeof emails === "string" ? [emails] : emails;
  const normalized = [
    ...new Set(values.map((email) => email.trim().toLowerCase())),
  ];
  if (
    normalized.length === 0 ||
    normalized.some((email) => email.length === 0)
  ) {
    throw clientValidationError(
      "At least one non-empty assignee email is required",
      "invalid_review_assignee_email",
    );
  }
  if (normalized.length > 64) {
    throw clientValidationError(
      "At most 64 assignee emails are allowed",
      "too_many_review_assignees",
    );
  }
  return normalized;
}

/** Managed project label catalog used by qualitative reviews. */
export class ProjectLabelsApi {
  constructor(private readonly dpHttp: HttpClient) {}

  list(params: ProjectLabelListParams = {}): Paginator<ProjectLabel> {
    return cursorPaginate(
      (next) =>
        this.dpHttp.request<Paginated<ProjectLabel>>({
          method: "GET",
          path: "/v1/project-labels",
          query: { ...params, next } as Record<string, unknown>,
        }),
      params.next,
    );
  }

  create(body: ProjectLabelCreate): Promise<ProjectLabel> {
    const slug = body.slug.trim();
    if (!slug || slug.length > 128) {
      throw clientValidationError(
        "Project label slug must contain 1 to 128 characters",
        "invalid_project_label_slug",
      );
    }
    if (!/^#[0-9a-f]{6}$/i.test(body.color)) {
      throw clientValidationError(
        "Project label color must be a six-digit hex color such as #f97316",
        "invalid_project_label_color",
      );
    }
    if (body.description != null && body.description.length > 2_000) {
      throw clientValidationError(
        "Project label description must not exceed 2000 characters",
        "invalid_project_label_description",
      );
    }
    return this.dpHttp.request<ProjectLabel>({
      method: "POST",
      path: "/v1/project-labels",
      body: { ...body, slug, color: body.color.toLowerCase() },
    });
  }

  get(slug: string): Promise<ProjectLabel> {
    return this.dpHttp.request<ProjectLabel>({
      method: "GET",
      path: `/v1/project-labels/${encodeURIComponent(slug)}`,
    });
  }

  update(slug: string, body: ProjectLabelUpdate): Promise<ProjectLabel> {
    if (body.description != null && body.description.length > 2_000) {
      throw clientValidationError(
        "Project label description must not exceed 2000 characters",
        "invalid_project_label_description",
      );
    }
    return this.dpHttp.request<ProjectLabel>({
      method: "PATCH",
      path: `/v1/project-labels/${encodeURIComponent(slug)}`,
      body,
    });
  }
}

/**
 * Qualitative review API. Mutations append one event; labels and assignees are
 * complete snapshots, while comments append to the span's review history.
 */
export class ReviewsApi {
  readonly labels: ProjectLabelsApi;

  constructor(
    private readonly cpHttp: HttpClient,
    private readonly dpHttp: HttpClient,
  ) {
    this.labels = new ProjectLabelsApi(dpHttp);
  }

  list(params: ReviewListParams = {}): Paginator<ReviewState> {
    return cursorPaginate(
      (next) =>
        this.dpHttp.request<Paginated<ReviewState>>({
          method: "GET",
          path: "/v1/annotations",
          query: { ...params, next } as Record<string, unknown>,
        }),
      params.next,
    );
  }

  /** Append exactly one qualitative-review mutation. */
  create(
    target: ReviewTarget,
    mutation: ReviewMutation,
    options: ReviewEventOptions = {},
  ): Promise<void> {
    return this.dpHttp.request<void>({
      method: "POST",
      path: "/v1/annotations",
      body: {
        ...target,
        event_id: options.event_id ?? reviewEventId(),
        ...mutation,
      },
      expect: "empty",
    });
  }

  comment(
    target: ReviewTarget,
    comment: string,
    options?: ReviewEventOptions,
  ): Promise<void> {
    return this.create(target, { comment }, options);
  }

  setLabels(
    target: ReviewTarget,
    labels: string[],
    options?: ReviewEventOptions,
  ): Promise<void> {
    return this.create(target, { labels }, options);
  }

  setAssignees(
    target: ReviewTarget,
    memberIds: Uuid[],
    options?: ReviewEventOptions,
  ): Promise<void> {
    return this.create(target, { assignee_member_ids: memberIds }, options);
  }

  clearAssignees(
    target: ReviewTarget,
    options?: ReviewEventOptions,
  ): Promise<void> {
    return this.setAssignees(target, [], options);
  }

  /**
   * Resolve active business members by exact email, merge them into the
   * target's current assignees, then emit the resulting complete snapshot.
   * All member pages are checked so an ambiguous identity can never be
   * selected by list order.
   */
  async assignByEmail(
    target: ReviewTarget,
    emails: string | readonly string[],
    options?: ReviewEventOptions,
  ): Promise<void> {
    const requestedMemberIds =
      await this.resolveActiveBusinessMemberIdsByEmail(emails);
    const current = await this.list({ ...target, limit: 1 });
    const existing = current.records[0]?.assignee_member_ids ?? [];
    const memberIds = [...new Set([...existing, ...requestedMemberIds])];
    if (memberIds.length > 64) {
      throw clientValidationError(
        "At most 64 review assignees are allowed",
        "too_many_review_assignees",
      );
    }
    if (memberIds.length === existing.length) return;
    await this.setAssignees(target, memberIds, options);
  }

  /**
   * Remove the requested active business members from the current assignee
   * snapshot. Already-unassigned members are an idempotent no-op.
   */
  async unassignByEmail(
    target: ReviewTarget,
    emails: string | readonly string[],
    options?: ReviewEventOptions,
  ): Promise<void> {
    const current = await this.list({ ...target, limit: 1 });
    const assignees = current.records[0]?.assignee_member_ids ?? [];
    const memberIds = new Set(
      await this.resolveActiveBusinessMemberIdsByEmail(
        emails,
        new Set(assignees),
      ),
    );
    const remaining = assignees.filter((memberId) => !memberIds.has(memberId));
    if (remaining.length === assignees.length) return;
    await this.setAssignees(target, remaining, options);
  }

  private async resolveActiveBusinessMemberIdsByEmail(
    emails: string | readonly string[],
    currentlyAssigned = new Set<Uuid>(),
  ): Promise<Uuid[]> {
    const requested = normalizedEmails(emails);
    const matches = new Map<string, ReviewMember[]>();
    for (const email of requested) matches.set(email, []);

    const members = cursorPaginate((next) =>
      this.cpHttp.request<Paginated<ReviewMember>>({
        method: "GET",
        path: "/v1/members",
        query: { limit: 1000, member_type: "business", next },
      }),
    );
    for await (const member of members) {
      if (
        (member.is_deactivated && !currentlyAssigned.has(member.id)) ||
        !member.email
      )
        continue;
      matches.get(member.email.trim().toLowerCase())?.push(member);
    }

    const memberIds: Uuid[] = [];
    for (const email of requested) {
      const candidates = matches.get(email) ?? [];
      if (candidates.length === 0) {
        throw new NotFoundError({
          message: `No active domain expert found for '${email}'`,
          status: 404,
          code: "review_assignee_not_found",
          body: { email },
        });
      }
      if (candidates.length > 1) {
        throw new ConflictError({
          message: `Multiple active domain experts found for '${email}'`,
          status: 409,
          code: "review_assignee_ambiguous",
          body: { email, member_ids: candidates.map((member) => member.id) },
        });
      }
      memberIds.push(candidates[0]!.id);
    }

    return memberIds;
  }
}

export function attachReviews(
  cpHttp: HttpClient,
  dpHttp: HttpClient,
): ReviewsApi {
  return new ReviewsApi(cpHttp, dpHttp);
}
