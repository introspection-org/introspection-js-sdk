/**
 * The bank's state on disk, so a restart mid-run keeps every venue's history.
 * Off unless TRIVIA_STATE_FILE names a file.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { dumpBank, loadBank } from "./bank";
import { dumpScores, loadScores } from "./scorer";

const FILE = process.env.TRIVIA_STATE_FILE;
const store = globalThis as unknown as { __triviaLoaded?: boolean };

export function loadState(): void {
  if (!FILE || store.__triviaLoaded) return;
  store.__triviaLoaded = true;
  if (!existsSync(FILE)) return;
  const saved = JSON.parse(readFileSync(FILE, "utf8"));
  loadBank(saved.bank ?? {});
  loadScores(saved.scores ?? {});
}

export function saveState(): void {
  if (!FILE) return;
  const next = `${FILE}.next`;
  writeFileSync(
    next,
    JSON.stringify({ bank: dumpBank(), scores: dumpScores() }),
  );
  renameSync(next, FILE);
}
