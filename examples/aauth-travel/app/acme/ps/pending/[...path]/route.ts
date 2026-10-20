/**
 * The agent polls a pending approval here with a signed GET, or withdraws it
 * with a DELETE. The Person Server names the tenant in the URL
 * (`/ps/pending/{tenant}/{id}`), so this takes every segment after `pending`.
 */
import { handle } from "@/lib/acme/person-server";
import { recorded } from "@/lib/demo/wire";

type Params = { params: Promise<{ path: string[] }> };

async function pending(request: Request, { params }: Params) {
  const { path } = await params;
  const rest = path.map(encodeURIComponent).join("/");
  return recorded("Acme", request, () =>
    handle(request, `/ps/pending/${rest}`),
  );
}

export const GET = pending;
export const DELETE = pending;
