import type {
  Automation,
  AutomationCreateParams,
  AutomationListParams,
  AutomationTriggerResponse,
  AutomationUpdateParams,
  Paginated,
  Uuid,
} from "@introspection-sdk/types";
import { Paginator, cursorPaginate } from "../pagination.js";
import type { ResourceHttpClient } from "./types.js";

/** The fields of `params` that are set, so a PATCH never sends an absent one. */
function setFields<T extends object>(params: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * CRUD on `/v1/automations` (Data Plane) plus `trigger(id)`, which runs one
 * now. Reading needs `automations:read` and writing `automations:write`; each
 * record's `can_manage` says whether the caller may update, trigger or delete
 * it. A firing is recorded on `/v1/events` as
 * `introspection.automation.triggered` (or `introspection.automation.skipped`
 * for a scheduled slot that ran nothing).
 *
 * The server serves these routes to administrators only today (a 403
 * otherwise); introspection-cloud#3137 opens them to members for their own
 * task-targeted automations.
 */
export class AutomationsClient {
  constructor(private readonly http: ResourceHttpClient) {}

  /**
   * List this project's automations. `await` the result for the first page,
   * or `for await` it to stream every automation across pages (fetched
   * lazily; stop early to stop fetching). Filters ride every page.
   */
  list(params: AutomationListParams = {}): Paginator<Automation> {
    const { next: start, ...filters } = params;
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Automation>>({
          method: "GET",
          path: "/v1/automations",
          query: { ...filters, next } as Record<string, unknown>,
        }),
      start,
    );
  }

  /** Create an automation; see {@link AutomationCreateParams}. */
  create(params: AutomationCreateParams): Promise<Automation> {
    return this.http.request<Automation>({
      method: "POST",
      path: "/v1/automations",
      body: setFields(params),
    });
  }

  /** Read one automation (soft-deleted ones included). */
  get(automationId: Uuid): Promise<Automation> {
    return this.http.request<Automation>({
      method: "GET",
      path: `/v1/automations/${encodeURIComponent(automationId)}`,
    });
  }

  /**
   * Update an automation. Only the fields set are sent; `metadata` replaces
   * the stored value wholesale.
   */
  update(
    automationId: Uuid,
    params: AutomationUpdateParams,
  ): Promise<Automation> {
    return this.http.request<Automation>({
      method: "PATCH",
      path: `/v1/automations/${encodeURIComponent(automationId)}`,
      body: setFields(params),
    });
  }

  /**
   * Soft-delete an automation. A project default (`observation_synthesis`,
   * `project_check_in`) cannot be deleted; disable it instead.
   */
  delete(automationId: Uuid): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/automations/${encodeURIComponent(automationId)}`,
      expect: "empty",
    });
  }

  /**
   * Run an automation now (`202`). Returns the task it created or posted
   * into; neither reads nor clears a scheduled slot.
   */
  trigger(automationId: Uuid): Promise<AutomationTriggerResponse> {
    return this.http.request<AutomationTriggerResponse>({
      method: "POST",
      path: `/v1/automations/${encodeURIComponent(automationId)}/trigger`,
    });
  }
}

export { AutomationsClient as AutomationsApi };
