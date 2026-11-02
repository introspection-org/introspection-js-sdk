import { randomBytes } from "node:crypto";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  type Paginated,
  type AnnotationListParams,
  type AnnotationEventOptions,
  type AnnotationFacet,
  type AnnotationNavigation,
  type AnnotationNavigationParams,
  type AnnotationMutation,
  type AnnotationState,
  type AnnotationTarget,
  type Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, cursorPaginate, paginateGet } from "../pagination.js";

interface AnnotationMember {
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
function annotationEventId(now = Date.now()): Uuid {
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
      "At least one non-empty reviewer email is required",
      "invalid_annotation_reviewer_email",
    );
  }
  if (normalized.length > 64) {
    throw clientValidationError(
      "At most 64 reviewer emails are allowed",
      "too_many_annotation_reviewers",
    );
  }
  return normalized;
}

/**
 * Member-authored span annotations. Every create call appends exactly one
 * event; labels and reviewers are complete snapshots.
 */
export class AnnotationsApi {
  constructor(
    private readonly cpHttp: HttpClient,
    private readonly dpHttp: HttpClient,
  ) {}

  list(params: AnnotationListParams = {}): Paginator<AnnotationState> {
    if (params.annotated_by_member_id && params.annotated_by_email) {
      throw clientValidationError(
        "Use annotated_by_member_id or annotated_by_email, not both",
        "conflicting_annotation_annotator_filters",
      );
    }
    if (params.assignee_member_id && params.assigned_to_email) {
      throw clientValidationError(
        "Use assignee_member_id or assigned_to_email, not both",
        "conflicting_annotation_assignee_filters",
      );
    }
    const { annotated_by_email, assigned_to_email, ...wireParams } = params;
    let resolvedFilters: Promise<Record<string, unknown>> | undefined;
    const resolveFilters = () => {
      resolvedFilters ??= (async () => {
        const emails = [annotated_by_email, assigned_to_email].filter(
          (email): email is string => Boolean(email),
        );
        const ids = emails.length ? await this.resolveReviewerIds(emails) : [];
        const sameEmail =
          annotated_by_email !== undefined &&
          assigned_to_email !== undefined &&
          annotated_by_email.trim().toLowerCase() ===
            assigned_to_email.trim().toLowerCase();
        return {
          ...wireParams,
          ...(annotated_by_email ? { annotated_by_member_id: ids[0] } : {}),
          ...(assigned_to_email
            ? {
                assignee_member_id:
                  ids[annotated_by_email && !sameEmail ? 1 : 0],
              }
            : {}),
        };
      })();
      return resolvedFilters;
    };
    return cursorPaginate(
      async (next) =>
        this.dpHttp.request<Paginated<AnnotationState>>({
          method: "GET",
          path: "/v1/annotations",
          query: { ...(await resolveFilters()), next },
        }),
      params.next,
    );
  }

  /**
   * The current annotator, assignee, label and status counts across the
   * project's annotations: the buckets a review queue filters by.
   */
  facets(): Promise<AnnotationFacet[]> {
    return this.dpHttp.request<AnnotationFacet[]>({
      method: "GET",
      path: "/v1/annotations/facets",
    });
  }

  /**
   * The annotations before and after one target in the review order the
   * filters select, with the target's position in it.
   */
  navigation(
    params: AnnotationNavigationParams,
  ): Promise<AnnotationNavigation> {
    return this.dpHttp.request<AnnotationNavigation>({
      method: "GET",
      path: "/v1/annotations/navigation",
      query: { ...params },
    });
  }

  /** Append exactly one annotation mutation. */
  async create(
    target: AnnotationTarget,
    mutation: AnnotationMutation,
    options: AnnotationEventOptions = {},
  ): Promise<void> {
    const wireMutation =
      mutation.reviewerEmails !== undefined
        ? {
            assignee_member_ids:
              mutation.reviewerEmails.length === 0
                ? []
                : await this.resolveReviewerIds(mutation.reviewerEmails),
          }
        : mutation;
    return this.dpHttp.request<void>({
      method: "POST",
      path: "/v1/annotations",
      body: {
        ...target,
        event_id: options.event_id ?? annotationEventId(),
        ...wireMutation,
      },
      expect: "empty",
    });
  }

  private async resolveReviewerIds(emails: readonly string[]): Promise<Uuid[]> {
    const requested = normalizedEmails(emails);
    const matches = new Map<string, AnnotationMember[]>();
    for (const email of requested) matches.set(email, []);

    const members = paginateGet<AnnotationMember>(this.cpHttp, "/v1/members", {
      limit: 1000,
      member_type: "business",
    });
    for await (const member of members) {
      if (member.is_deactivated || !member.email) continue;
      matches.get(member.email.trim().toLowerCase())?.push(member);
    }

    const memberIds: Uuid[] = [];
    for (const email of requested) {
      const candidates = matches.get(email) ?? [];
      if (candidates.length === 0) {
        throw new NotFoundError({
          message: `No active domain expert found for '${email}'`,
          status: 404,
          code: "annotation_reviewer_not_found",
          body: { email },
        });
      }
      if (candidates.length > 1) {
        throw new ConflictError({
          message: `Multiple active domain experts found for '${email}'`,
          status: 409,
          code: "annotation_reviewer_ambiguous",
          body: { email, member_ids: candidates.map((member) => member.id) },
        });
      }
      memberIds.push(candidates[0]!.id);
    }

    return memberIds;
  }
}

export function attachAnnotations(
  cpHttp: HttpClient,
  dpHttp: HttpClient,
): AnnotationsApi {
  return new AnnotationsApi(cpHttp, dpHttp);
}
