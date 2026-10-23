import type {
  Image,
  ImageCreateParams,
  ImageListParams,
} from "@introspection-sdk/types";
import { CollectionClient } from "./collection.js";
import type { ResourceHttpClient } from "./types.js";

/**
 * `/v1/images` (Data Plane): what an eval task's compose services run as.
 *
 * An image is built from a context archive uploaded through the Files API, or
 * mirrored from an upstream reference pinned by digest, and always lands in
 * the plane's registry. A create records the image and sends its build; it is
 * idempotent on content, so the same source returns the existing row and
 * resending it retries a failed build. `status` is the only progress report,
 * so poll `get` until it is `ready` (or `failed`). Deleting a runtime image
 * rebakes it; one still baking answers 409.
 *
 * Gated on `images:read` / `images:write`, which an org admin or owner and
 * the `operator` role hold, on a plane with evals enabled (a create answers
 * 422 otherwise). The credential must name a project.
 */
export class ImagesClient extends CollectionClient<
  Image,
  ImageCreateParams,
  ImageListParams
> {
  constructor(http: ResourceHttpClient) {
    super(http, "/v1/images");
  }
}

export { ImagesClient as ImagesApi };
