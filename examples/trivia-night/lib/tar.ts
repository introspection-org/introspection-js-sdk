/**
 * A gzipped ustar archive of files held in memory, with no entry for the
 * directory itself: the platform unpacks a verifier's archive into a mounted
 * `/tests` with a plain `tar -xzf`, and an entry for `.` would have tar set the
 * mount's mode and times, which the sandbox user may not. Fixed times, owner
 * and order, so the same files always make the same bytes.
 */
import { gzipSync } from "node:zlib";

export interface TarFile {
  /** Relative path inside the archive, `/`-separated. */
  path: string;
  content: Uint8Array;
  /** Defaults to 0o644. */
  mode?: number;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(path: string, size: number, mode: number): Uint8Array {
  const name = Buffer.from(path, "utf8");
  let prefix = Buffer.alloc(0);
  let base = name;
  if (name.length > 100) {
    const split = path.lastIndexOf("/", 155);
    if (split <= 0 || Buffer.byteLength(path.slice(split + 1)) > 100)
      throw new Error(`${path} is too long for a tar header`);
    prefix = Buffer.from(path.slice(0, split), "utf8");
    base = Buffer.from(path.slice(split + 1), "utf8");
  }
  const block = Buffer.alloc(BLOCK);
  base.copy(block, 0);
  block.write(octal(mode, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(0, 12), 136, "ascii");
  block.fill(" ", 148, 156);
  block.write("0", 156, "ascii");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  prefix.copy(block, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 7) + " ", 148, "ascii");
  return block;
}

export function tarGz(files: TarFile[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!file.path || file.path.startsWith("/") || file.path.includes(".."))
      throw new Error(`${file.path} is not a relative path`);
    parts.push(header(file.path, file.content.length, file.mode ?? 0o644));
    parts.push(file.content);
    const pad = (BLOCK - (file.content.length % BLOCK)) % BLOCK;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return new Uint8Array(gzipSync(Buffer.concat(parts), { level: 9 }));
}
