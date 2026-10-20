/**
 * Upload a file, start a task that reads it, and download the file back.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   pnpm patterns-files
 *
 * Optional env:
 *   INTROSPECTION_RUNTIME       - runtime slug or ID (default customer-agent)
 *   INTROSPECTION_BASE_API_URL  - CP API host
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("Set INTROSPECTION_TOKEN to an Introspection API key.");
}
const client = new IntrospectionClient();
const runner = await client
  .runtimes(process.env.INTROSPECTION_RUNTIME ?? "customer-agent")
  .run();
const blob = new Blob(["Contract: the supplier delivers by 1 March."], {
  type: "application/pdf",
});

// #region docs:patterns/files/sdk-upload
const f = await runner.files.upload({ file: blob, name: "contract.pdf", file_type: "upload" });
const handle = await runner.tasks.start({ prompt: "Review contract.pdf", files: [{ id: f.id }] });
const bytes = await runner.files.download(f.id);
// #endregion docs:patterns/files/sdk-upload

await handle.text();
console.log(`uploaded ${f.id}, downloaded ${bytes.byteLength} bytes`);
await runner.files.delete(f.id);
