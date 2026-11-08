/**
 * Where every branch points, read from the repository's own files instead of
 * a git process: the loose files under `refs/heads/` and the `refs/heads/`
 * lines of `packed-refs`, a loose ref winning as in git. The answer is one
 * string, `name oid` lines sorted by name, so two reads compare equal exactly
 * when no branch moved, appeared or went away.
 *
 * Anything this does not fully understand (a symbolic ref, an odd line, a
 * reftable repository) answers undefined, and the caller asks git.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function headsState(dir: string): string | undefined {
  if (existsSync(join(dir, "reftable"))) return undefined;
  const heads = new Map<string, string>();
  let packed = "";
  try {
    packed = readFileSync(join(dir, "packed-refs"), "utf8");
  } catch {
    // no packed-refs: every branch is loose
  }
  for (const line of packed.split("\n")) {
    if (line === "" || line[0] === "#" || line[0] === "^") continue;
    const space = line.indexOf(" ");
    const oid = line.slice(0, space);
    const name = line.slice(space + 1);
    if (!OID.test(oid)) return undefined;
    if (name.startsWith("refs/heads/")) heads.set(name, oid);
  }
  let loose: string[];
  try {
    loose = readdirSync(join(dir, "refs/heads"), { recursive: true, withFileTypes: true })
      .filter((e) => !e.isDirectory())
      .map((e) => join(e.parentPath, e.name));
  } catch {
    return undefined;
  }
  for (const path of loose) {
    if (path.endsWith(".lock")) return undefined; // a write in flight: let git answer
    let text: string;
    try {
      text = readFileSync(path, "utf8").trim();
    } catch {
      return undefined; // moved while we looked: let git answer
    }
    if (!OID.test(text)) return undefined;
    heads.set(relative(dir, path).split(sep).join("/"), text);
  }
  return [...heads]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, oid]) => `${name} ${oid}`)
    .join("\n");
}
