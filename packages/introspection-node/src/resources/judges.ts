import type {
  Judge,
  JudgeListParams,
  JudgeUpdateParams,
  ProjectRef,
  Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, paginateGet } from "../pagination.js";
import { projectQuery } from "./project-scoped.js";

/**
 * `/v1/judges` (Control Plane): the judges a project's Recipes declare.
 *
 * A judge is authored in its Recipe and published with it, so there is no
 * create or delete here; an update changes only whether it runs and how
 * often. Gated on `judges:read` / `judges:write`.
 */
export class JudgesApi {
  constructor(private readonly http: HttpClient) {}

  /** `await` for the first page, or `for await` to stream every judge. */
  list(params: JudgeListParams = {}): Paginator<Judge> {
    return paginateGet<Judge>(this.http, "/v1/judges", params, params.next);
  }

  get(judgeId: Uuid, project?: ProjectRef): Promise<Judge> {
    return this.http.request<Judge>({
      method: "GET",
      path: `/v1/judges/${encodeURIComponent(judgeId)}`,
      query: projectQuery(project),
    });
  }

  /** Change `enabled` and/or `sample_rate`. */
  update(
    judgeId: Uuid,
    params: JudgeUpdateParams,
    project?: ProjectRef,
  ): Promise<Judge> {
    return this.http.request<Judge>({
      method: "PATCH",
      path: `/v1/judges/${encodeURIComponent(judgeId)}`,
      query: projectQuery(project),
      body: params,
    });
  }
}
