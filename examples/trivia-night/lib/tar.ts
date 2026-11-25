/**
 * A gzipped ustar archive of files held in memory, with no entry for the
 * directory itself: the platform unpacks a verifier's archive into a mounted
 * `/tests` with a plain `tar -xzf`, and an entry for `.` would have tar set the
 * mount's mode and times, which the sandbox user may not. Fixed times, owner
 * and order, so the same files always make the same bytes. Web APIs only, so
 * the browser builds it.
 */

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

const encode = (text: string) => new TextEncoder().encode(text);

function header(path: string, size: number, mode: number): Uint8Array {
  const name = encode(path);
  let prefix = new Uint8Array(0);
  let base = name;
  if (name.length > 100) {
    const split = path.lastIndexOf("/", 155);
    if (split <= 0 || encode(path.slice(split + 1)).length > 100)
      throw new Error(`${path} is too long for a tar header`);
    prefix = encode(path.slice(0, split));
    base = encode(path.slice(split + 1));
  }
  const block = new Uint8Array(BLOCK);
  const write = (text: string, at: number) => block.set(encode(text), at);
  block.set(base, 0);
  write(octal(mode, 8), 100);
  write(octal(0, 8), 108);
  write(octal(0, 8), 116);
  write(octal(size, 12), 124);
  write(octal(0, 12), 136);
  block.fill(0x20, 148, 156);
  write("0", 156);
  write("ustar\0", 257);
  write("00", 263);
  block.set(prefix, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  write(octal(sum, 7) + " ", 148);
  return block;
}

export async function tarGz(files: TarFile[]): Promise<Uint8Array> {
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
  const tar = new Blob(parts as BlobPart[]).stream();
  return new Uint8Array(
    await new Response(
      tar.pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
}
