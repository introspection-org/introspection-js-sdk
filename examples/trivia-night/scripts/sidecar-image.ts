/**
 * `pnpm sidecar:image`: builds the image each trial's sidecar runs (the
 * trivia bank fake) from this checkout, once per change to its folder. The
 * page finds it by the folder's git tree id at the runtime's commit, but cannot
 * build it, since the repository contents API returns no file over 1 MB whole.
 * Every file is checked against the runtime's repository first, so the image
 * is the commit's folder exactly. Runs as the member `introspection login`
 * signed in, in their project.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import VENUES from "../recipe-operator/evals/venues.json";
import { taskName } from "../lib/platform-evals";
import { cliSession } from "../lib/cli-session";
import {
  readTaskDefinition,
  resolveTarget,
  sidecarImageName,
  type PlatformClient,
} from "../lib/platform-runner";
import { tarGz, type TarFile } from "../lib/tar";

const POLL_MS = 3000;
const TIMEOUT_MS = 30 * 60 * 1000;
const UPLOAD_TTL_SECONDS = 24 * 3600;

const blobId = (content: Buffer) =>
  createHash("sha1")
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest("hex");

async function hostedFiles(
  client: PlatformClient,
  repository: string,
  ref: string,
  dir: string,
): Promise<{ path: string; sha: string }[]> {
  const out: { path: string; sha: string }[] = [];
  for await (const entry of client.repositories.contents(repository, {
    path: dir,
    ref,
  })) {
    if (entry.type === "dir")
      out.push(...(await hostedFiles(client, repository, ref, entry.path)));
    else out.push({ path: entry.path, sha: entry.sha });
  }
  return out;
}

async function main() {
  const { client, project } = cliSession();
  const target = await resolveTarget(client, project);
  const definition = await readTaskDefinition(
    client,
    target,
    taskName(1, VENUES[0].slug),
  );
  for (const [service, context] of Object.entries(definition.contexts)) {
    const parent = path.posix.dirname(context);
    let tree: string | null = null;
    for await (const entry of client.repositories.contents(target.repository!, {
      path: parent === "." ? "" : parent,
      ref: target.commit,
    }))
      if (entry.path === context) tree = entry.sha;
    if (!tree) throw new Error(`${context} is not in the runtime's repository`);
    const name = sidecarImageName(service, tree);
    const existing = await client.images.list({ name, status: "ready" });
    if (existing.records.length) {
      console.log(`${name} is ready`);
      continue;
    }
    const relative = path.posix.relative(target.recipe_path ?? "", context);
    const local = path.join(process.cwd(), "recipe-operator", relative);
    const files: TarFile[] = [];
    const differ: string[] = [];
    for (const hosted of await hostedFiles(
      client,
      target.repository!,
      target.commit,
      context,
    )) {
      const inside = path.posix.relative(context, hosted.path);
      const file = path.join(local, inside);
      let content: Buffer;
      try {
        content = readFileSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        differ.push(`${inside} (missing here)`);
        continue;
      }
      if (blobId(content) !== hosted.sha) differ.push(inside);
      files.push({
        path: inside,
        content,
        mode: statSync(file).mode & 0o111 ? 0o755 : 0o644,
      });
    }
    if (differ.length)
      throw new Error(
        `recipe-operator/${relative} differs from ${target.commit.slice(0, 12)} in ${differ.join(", ")}: push this checkout (pnpm dev) or check out that commit`,
      );
    const upload = await client.files.upload({
      file: tarGz(files),
      name: `${service}-context.tar.gz`,
      contentType: "application/gzip",
      ttl_seconds: UPLOAD_TTL_SECONDS,
    });
    let image = await client.images.create({
      name,
      source: { kind: "context", file_id: upload.id },
      provenance: {
        service,
        repository_id: target.repository,
        git_sha: target.commit,
        path: context,
      },
    });
    console.log(`building ${name} (${image.id})`);
    const deadline = Date.now() + TIMEOUT_MS;
    while (
      !["ready", "failed", "cancelled", "evicted"].includes(image.status)
    ) {
      if (Date.now() > deadline)
        throw new Error(`${name} is still ${image.status}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      image = await client.images.get(image.id);
    }
    if (image.status !== "ready")
      throw new Error(
        `${name} is ${image.status}: ${image.error ?? "no error recorded"}`,
      );
    console.log(`${name} is ready`);
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
