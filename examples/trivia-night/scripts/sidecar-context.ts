/**
 * Packs the trials' bank sidecar, recipe-operator/fakes/ as git tracks it,
 * into public/sidecar/fakes.tar.gz, which the page uploads as the sidecar's
 * build context. The archive's bytes are fixed by its files, so the platform
 * builds the image once per change to the folder. Runs before `next dev` and
 * `next build`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { tarGz } from "../lib/tar";
import { SIDECAR_ARCHIVE } from "../lib/platform-runner";

const root = path.join(import.meta.dirname, "..");
const context = path.join(root, "recipe-operator/fakes");
const files = execFileSync("git", ["ls-files", "-z"], {
  cwd: context,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean)
  .map((file) => {
    const absolute = path.join(context, file);
    return {
      path: file,
      content: readFileSync(absolute),
      mode: statSync(absolute).mode & 0o111 ? 0o755 : 0o644,
    };
  });
if (!files.length) throw new Error(`git tracks nothing in ${context}`);
const out = path.join(root, "public", SIDECAR_ARCHIVE);
mkdirSync(path.dirname(out), { recursive: true });
tarGz(files)
  .then((archive) => writeFileSync(out, archive))
  .catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
