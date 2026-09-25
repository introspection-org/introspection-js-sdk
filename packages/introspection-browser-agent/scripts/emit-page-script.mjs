// Publishes the in-page script as a standalone file so non-JS clients (the
// introspection CLI) can embed the exact build, pinned by its SHA-256.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PAGE_SCRIPT } from "../dist/page-script.js";

const dist = join(import.meta.dirname, "..", "dist");
writeFileSync(join(dist, "browser.v1.js"), PAGE_SCRIPT);
const digest = createHash("sha256").update(PAGE_SCRIPT).digest("hex");
writeFileSync(join(dist, "browser.v1.js.sha256"), `${digest}\n`);
