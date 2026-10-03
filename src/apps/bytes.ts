/**
 * How many bytes a directory holds: the apparent size of every regular
 * file under it, summed. Symlinks are counted as themselves and never
 * followed, so a link out of the tree cannot bill for what it points at;
 * a path that is missing (an environment never deployed) holds 0 bytes.
 * Asynchronous, so walking a large repository does not hold up a request.
 */

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function dirBytes(path: string): Promise<number> {
  let total = 0;
  const pending = [path];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let names: string[];
    try {
      const info = await lstat(dir);
      if (!info.isDirectory()) {
        if (info.isFile()) total += info.size;
        continue;
      }
      names = await readdir(dir);
    } catch {
      continue; // gone between the listing and the look: nothing to count
    }
    for (const name of names) {
      const child = join(dir, name);
      try {
        const info = await lstat(child);
        if (info.isDirectory()) pending.push(child);
        else if (info.isFile()) total += info.size;
      } catch {
        // removed while walking
      }
    }
  }
  return total;
}
