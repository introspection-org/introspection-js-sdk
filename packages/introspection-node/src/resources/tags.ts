import {
  ValidationError,
  type Paginated,
  type Tag,
  type TagCreate,
  type TagKind,
  type TagListParams,
  type TagUpdate,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, cursorPaginate } from "../pagination.js";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function clientValidationError(message: string, code: string): ValidationError {
  return new ValidationError({
    message,
    status: 422,
    code,
    body: null,
  });
}

function tagPath(kind: TagKind, name: string): string {
  // An access tag's name may contain `/`, so it is encoded even though the
  // API matches it as a path.
  return `/v1/tags/${kind}/${encodeURIComponent(name)}`;
}

function checkDescription(description: string | null | undefined): void {
  if (description != null && description.length > 2_000) {
    throw clientValidationError(
      "Tag description must not exceed 2000 characters",
      "invalid_tag_description",
    );
  }
}

function checkColor(color: string): void {
  if (!HEX_COLOR.test(color)) {
    throw clientValidationError(
      "Tag color must be a six-digit hex color such as #f97316",
      "invalid_tag_color",
    );
  }
}

/**
 * The project tag catalogue: the values a share, a member tag, or an
 * annotation carries, keyed by {@link TagKind}.
 */
export class TagsApi {
  constructor(private readonly dpHttp: HttpClient) {}

  /** List one catalogue. `kind` is required: no listing spans both. */
  list(kind: TagKind, params: TagListParams = {}): Paginator<Tag> {
    return cursorPaginate(
      (next) =>
        this.dpHttp.request<Paginated<Tag>>({
          method: "GET",
          path: "/v1/tags",
          query: { ...params, kind, next } as Record<string, unknown>,
        }),
      params.next,
    );
  }

  /** Add a tag. An existing one comes back as it is, a deleted one revives. */
  create(tag: TagCreate): Promise<Tag> {
    const name = tag.name.trim();
    if (!name || name.length > 128) {
      throw clientValidationError(
        "Tag name must contain 1 to 128 characters",
        "invalid_tag_name",
      );
    }
    checkDescription(tag.description);
    let body: TagCreate;
    if (tag.kind === "annotation") {
      checkColor(tag.color);
      body = { ...tag, name, color: tag.color.toLowerCase() };
    } else {
      if ((tag as { color?: unknown }).color !== undefined) {
        throw clientValidationError(
          "An access tag has no color",
          "invalid_tag_color",
        );
      }
      body = { ...tag, name };
    }
    if (body.description == null) delete body.description;
    return this.dpHttp.request<Tag>({ method: "POST", path: "/v1/tags", body });
  }

  get(kind: TagKind, name: string): Promise<Tag> {
    return this.dpHttp.request<Tag>({
      method: "GET",
      path: tagPath(kind, name),
    });
  }

  /** Only the keys present are sent: an absent key leaves the value alone. */
  update(kind: TagKind, name: string, patch: TagUpdate): Promise<Tag> {
    const body: TagUpdate = {};
    if (patch.color !== undefined) {
      if (kind === "access") {
        throw clientValidationError(
          "An access tag has no color",
          "invalid_tag_color",
        );
      }
      checkColor(patch.color);
      body.color = patch.color.toLowerCase();
    }
    if (patch.description !== undefined) {
      checkDescription(patch.description);
      body.description = patch.description;
    }
    if (Object.keys(body).length === 0) {
      throw clientValidationError(
        "A tag update must name a color or a description",
        "invalid_tag_update",
      );
    }
    return this.dpHttp.request<Tag>({
      method: "PATCH",
      path: tagPath(kind, name),
      body,
    });
  }

  /** Remove a tag from the catalogue. Shares, member tags and annotations keep theirs. */
  delete(kind: TagKind, name: string): Promise<void> {
    return this.dpHttp.request<void>({
      method: "DELETE",
      path: tagPath(kind, name),
      expect: "empty",
    });
  }
}

export function attachTags(dpHttp: HttpClient): TagsApi {
  return new TagsApi(dpHttp);
}
