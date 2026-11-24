// Night 0's one check: memories/MEMORY.md holds exactly the given notes
// (tests/notes.md), so the night 2 after it starts from known-perfect notes.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const clean = (text) => text.replace(/\r\n/g, "\n").trim();
const want = clean(
  readFileSync(new URL("./notes.md", import.meta.url), "utf8"),
);
const notesPath = "/workspace/memories/MEMORY.md";
const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
const scores = { notes_seeded: clean(notes) === want ? 1 : 0 };
const reward = scores.notes_seeded;
writeFileSync(
  "/logs/verifier/reward.json",
  JSON.stringify({ reward, ...scores }),
);
console.log(JSON.stringify({ reward, ...scores, notes }, null, 2));
