/**
 * The check cell's memory in words: what forge.json asks for and what the
 * machine holds the cell to. One number when they agree; both, and where the
 * cut comes from, when forge.json asks for more. The settings page and the
 * terminal say the same sentence.
 */

import { readFileAt } from "./checkout.ts";
import { memoryCeilingSource, OWN_SIZE_SHARE, POD_MEMORY_FILE, POD_MEMORY_SHARE, resolveLimits, type CeilingFrom, type Limits } from "./contain.ts";
import { parseCheck } from "./manifest.ts";

interface Held {
  readonly limits: Limits;
  readonly from: CeilingFrom;
}

const held = new Map<string, Held>();

let podFile = POD_MEMORY_FILE;

/** Read the pod's memory limit from `path` (a test's fixture); the returned function puts the real file back. */
export function usePodMemoryFile(path: string): () => void {
  podFile = path;
  return () => {
    podFile = POD_MEMORY_FILE;
  };
}

/**
 * The limits a check cell gets for a declared memory. `resolveLimits` reads
 * the pod's cgroup file, so the answer is kept per (env, declaration) and the
 * file is read once, not on every request.
 */
function cellLimits(declared: number | undefined): Held {
  const env = process.env["FORGE_CELL_MEMORY_MAX_MIB"];
  const key = `${podFile}|${env ?? ""}|${process.env["FORGE_CELL_SIZE"] ?? ""}|${declared ?? ""}`;
  let kept = held.get(key);
  if (!kept) {
    kept = {
      limits: resolveLimits("step", declared === undefined ? undefined : { memoryMiB: declared }, podFile),
      from: memoryCeilingSource(env, podFile),
    };
    if (held.size >= 64) held.clear();
    held.set(key, kept);
  }
  return kept;
}

/** Where the ceiling a cut was held to comes from, in words. */
export function ceilingWords(from: CeilingFrom): string {
  return from === "env"
    ? "the machine's ceiling, FORGE_CELL_MEMORY_MAX_MIB"
    : from === "size"
      ? `${Math.round(OWN_SIZE_SHARE * 100)}% of this child forge's own size`
      : from === "pod"
        ? `${Math.round(POD_MEMORY_SHARE * 100)}% of the pod's memory.max`
        : "the machine's default ceiling; the pod states no memory limit";
}

/** The sentence for a declared memory; with none declared it says the default holds. Only validated numbers enter it. */
export function checkMemoryWords(declared: number | undefined): string {
  const { limits: cell, from } = cellLimits(declared);
  if (declared === undefined) return `The check cell holds ${cell.memoryMiB} MiB (the default; forge.json declares none).`;
  if (cell.memorySource !== "ceiling") return `The check cell holds ${cell.memoryMiB} MiB.`;
  return `forge.json asks ${declared} MiB; the cell holds ${cell.memoryMiB} MiB (${ceilingWords(from)}).`;
}

/** What forge.json declared at a commit: `null` unreadable, `undefined` no check, else its memory (or none). */
type Declared = null | undefined | { readonly memoryMiB: number | undefined };

const declaredAt = new Map<string, Declared>();

/**
 * The sentence for the check forge.json declares at `oid`. `undefined` when
 * it declares none; `null` when it declares one that cannot be read. A commit
 * never changes, so what it declares is read from git once per (dir, oid).
 */
export async function checkMemoryAt(
  dir: string,
  oid: string | undefined,
): Promise<string | null | undefined> {
  if (oid === undefined) return undefined;
  const key = `${dir}|${oid}`;
  let declared = declaredAt.get(key);
  if (declared === undefined && !declaredAt.has(key)) {
    const [forgeJson, packageJson] = await Promise.all([
      readFileAt(dir, oid, "forge.json"),
      readFileAt(dir, oid, "package.json"),
    ]);
    const check = parseCheck(forgeJson, packageJson);
    declared = !check.ok ? null : check.value === undefined ? undefined : { memoryMiB: check.value.limits.memoryMiB };
    if (declaredAt.size >= 256) declaredAt.clear();
    declaredAt.set(key, declared);
  }
  return declared === null ? null : declared === undefined ? undefined : checkMemoryWords(declared.memoryMiB);
}
