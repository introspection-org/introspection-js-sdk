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
  type AnnotationListParams,
  type AnnotationEventOptions,
  type AnnotationMutation,
  type AnnotationState,
  type AnnotationTarget,
  type Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, cursorPaginate } from "../pagination.js";

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

/** Managed project label catalog used by annotations. */
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
 * Member-authored span annotations. Every create call appends exactly one
 * event; labels and reviewers are complete snapshots.
 */
export class AnnotationsApi {
  constructor(
    private readonly cpHttp: HttpClient,
    private readonly dpHttp: HttpClient,
  ) {}

  list(params: AnnotationListParams = {}): Paginator<AnnotationState> {
    return cursorPaginate(
      (next) =>
        this.dpHttp.request<Paginated<AnnotationState>>({
          method: "GET",
          path: "/v1/annotations",
          query: { ...params, next } as Record<string, unknown>,
        }),
      params.next,
    );
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

    const members = cursorPaginate((next) =>
      this.cpHttp.request<Paginated<AnnotationMember>>({
        method: "GET",
        path: "/v1/members",
        query: { limit: 1000, member_type: "business", next },
      }),
    );
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

export function attachProjectLabels(dpHttp: HttpClient): ProjectLabelsApi {
  return new ProjectLabelsApi(dpHttp);
}
