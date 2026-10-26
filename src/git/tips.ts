/**
 * Where refs point, read from the repository's own files instead of a git
 * process: a loose ref is one small file, a packed one a line in
 * `packed-refs`. Anything else (a symbolic ref, a missing file) is simply
 * absent here, and the caller asks git.
 */
import { join } from "node:path";
import { isSafeRef } from "./guard.ts";

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export async function readTips(
  dir: string,
  names: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const rest: string[] = [];
  for (const name of new Set(names)) {
    if (!isSafeRef(name) || !name.startsWith("refs/")) continue;
    try {
      const text = (await Bun.file(join(dir, name)).text()).trim();
      if (OID.test(text)) out.set(name, text);
    } catch {
      rest.push(name);
    }
  }
  if (rest.length === 0) return out;
  let packed = "";
  try {
    packed = await Bun.file(join(dir, "packed-refs")).text();
  } catch {
    return out;
  }
  const want = new Set(rest);
  for (const line of packed.split("\n")) {
    if (line === "" || line[0] === "#" || line[0] === "^") continue;
    const space = line.indexOf(" ");
    const name = line.slice(space + 1);
    const oid = line.slice(0, space);
    if (want.has(name) && OID.test(oid)) out.set(name, oid);
  }
  return out;
}
