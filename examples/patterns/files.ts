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
const blob = new Blob([minimalPdf("Contract: the supplier delivers by 1 March.")], {
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

// A one-page PDF with a single line of text, so the upload is a real document.
function minimalPdf(text: string): string {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  return `${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
