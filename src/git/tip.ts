/**
 * A branch tip read from the repository's own files, without a process:
 * the loose ref, else the line in packed-refs. Anything else (a symbolic
 * ref, a missing file, a surprise) is `undefined`, and the caller asks git.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isSafeOid, isSafeRef } from "./guard.ts";

async function text(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function readTip(
  dir: string,
  ref: string,
): Promise<string | undefined> {
  if (!isSafeRef(ref) || !ref.startsWith("refs/heads/")) return undefined;
  const loose = (await text(join(dir, ref)))?.trim();
  if (loose !== undefined) return isSafeOid(loose) ? loose : undefined;
  const packed = await text(join(dir, "packed-refs"));
  if (packed === undefined) return undefined;
  for (const line of packed.split("\n")) {
    const [oid, name] = line.split(" ");
    if (name === ref && oid !== undefined && isSafeOid(oid)) return oid;
  }
  return undefined;
}
