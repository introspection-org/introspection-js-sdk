import type {
  Routine,
  RoutineCreateParams,
  RoutineListParams,
  RoutineTriggerBody,
  RoutineTriggerParams,
  RoutineTriggerResponse,
  RoutineUpdateParams,
  Uuid,
} from "@introspection-sdk/types";
import { Paginator, paginateGet } from "../pagination.js";
import { FilesClient } from "./files.js";
import { setFields } from "./set-fields.js";
import type { ResourceHttpClient } from "./types.js";

const PARAMETERS_FILE_NAME = "parameters.json";
const PARAMETERS_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * CRUD on `/v1/routines` (Data Plane) plus `trigger(id)`, which runs one
 * now. Reading needs `routines:read` and writing `routines:write`; each
 * record's `can_manage` says whether the caller may update, trigger or delete
 * it. A firing is recorded on `/v1/events` as
 * `introspection.routines.triggered` (or `introspection.routines.skipped`
 * for a scheduled slot or event delivery that ran nothing). A routine's
 * `triggers` start runs on events: an integration's (Slack, GitHub) or a
 * `webhook` connector's calls.
 *
 * The server serves these routes to administrators only today (a 403
 * otherwise); introspection-cloud#3137 opens them to members for their own
 * task-targeted routines.
 */
export class RoutinesClient {
  constructor(private readonly http: ResourceHttpClient) {}

  /**
   * List this project's routines. `await` the result for the first page,
   * or `for await` it to stream every routine across pages (fetched
   * lazily; stop early to stop fetching). Filters ride every page.
   */
  list(params: RoutineListParams = {}): Paginator<Routine> {
    const { next: start, ...filters } = params;
    return paginateGet<Routine>(
      this.http,
      "/v1/routines",
      filters,
      start,
      "Paginated<Routine>",
    );
  }

  /** Create a routine; see {@link RoutineCreateParams}. */
  create(params: RoutineCreateParams): Promise<Routine> {
    return this.http.request<Routine>({
      method: "POST",
      path: "/v1/routines",
      schema: "Routine",
      body: setFields(params),
    });
  }

  /** Read one routine (soft-deleted ones included). */
  get(routineId: Uuid): Promise<Routine> {
    return this.http.request<Routine>({
      method: "GET",
      path: `/v1/routines/${encodeURIComponent(routineId)}`,
      schema: "Routine",
    });
  }

  /**
   * Update a routine. Only the fields set are sent; `metadata` replaces
   * the stored value wholesale.
   */
  update(routineId: Uuid, params: RoutineUpdateParams): Promise<Routine> {
    return this.http.request<Routine>({
      method: "PATCH",
      path: `/v1/routines/${encodeURIComponent(routineId)}`,
      schema: "Routine",
      body: setFields(params),
    });
  }

  /**
   * Soft-delete a routine. A project default (`observation_synthesis`,
   * `project_check_in`) cannot be deleted; disable it instead.
   */
  delete(routineId: Uuid): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/routines/${encodeURIComponent(routineId)}`,
      expect: "empty",
    });
  }

  /**
   * Run a routine now (`202`), with optional parameters and files (see
   * {@link RoutineTriggerParams}). With `parameters` and no
   * `attachParametersFile`, it reads the routine first and uploads
   * `parameters.json` only for one that starts its own task. Returns the task it
   * created or posted into, and the kind's `result`; neither reads nor
   * clears a scheduled slot.
   */
  async trigger(
    routineId: Uuid,
    params: RoutineTriggerParams = {},
  ): Promise<RoutineTriggerResponse> {
    const { parameters, parametersFile, attachParametersFile } = params;
    if (parameters !== undefined && parametersFile !== undefined) {
      throw new TypeError("Pass parameters or parametersFile, not both");
    }
    const files = [...(params.files ?? [])];
    if (parametersFile !== undefined) {
      const id =
        typeof parametersFile === "string" ? parametersFile : parametersFile.id;
      files.unshift({ id, name: PARAMETERS_FILE_NAME });
    } else if (
      parameters !== undefined &&
      (attachParametersFile ?? (await this.startsOwnTask(routineId)))
    ) {
      const uploaded = await new FilesClient(this.http).createText({
        name: `routine-parameters/${crypto.randomUUID()}.json`,
        content: JSON.stringify(parameters),
        mime_type: "application/json",
        ttl_seconds: PARAMETERS_TTL_SECONDS,
      });
      files.unshift({ id: uploaded.id, name: PARAMETERS_FILE_NAME });
    }
    const body: RoutineTriggerBody = setFields({
      parameters,
      files: files.length > 0 ? files : undefined,
    });
    return this.http.request<RoutineTriggerResponse>({
      method: "POST",
      path: `/v1/routines/${encodeURIComponent(routineId)}/trigger`,
      schema: "RoutineTriggerResponse",
      ...(Object.keys(body).length > 0 ? { body } : {}),
    });
  }

  private async startsOwnTask(routineId: Uuid): Promise<boolean> {
    const routine = await this.get(routineId);
    return routine.kind == null && routine.task_id == null;
  }
}

export { RoutinesClient as RoutinesApi };
