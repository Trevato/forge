/**
 * Where the forge runs with less than its default protection, in one line.
 *
 * The default is that repository code runs in a cell (`apps/contain.ts`) and
 * an agent's shell in a sandbox (`crew/sandbox.ts`). Where the host cannot
 * hold either, the forge still works — and says so: a log warning at boot,
 * and this line in the foot of every page a site admin reads. Each part
 * reports itself once, when it learns what the host can do; a part that
 * works reports nothing, so a fully protected forge shows no line at all.
 */

const lacking = new Map<string, string>();

/** A part says what it lacks (`ok`: nothing) and why, e.g. `("apps", "bwrap is not installed")`. */
export function noteProtection(
  part: string,
  result: { ok: true } | { ok: false; reason: string },
): void {
  if (result.ok) lacking.delete(part);
  else lacking.set(part, result.reason);
}

/** The one-line notice, or `undefined` when nothing is reduced. Plain text: escape it. */
export function protectionNotice(): string | undefined {
  if (lacking.size === 0) return undefined;
  const parts = [...lacking]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([part, reason]) => `${part} (${reason})`);
  return `Reduced protection: ${parts.join("; ")} run${parts.length === 1 ? "s" : ""} uncontained.`;
}

/** For tests. */
export function resetProtection(): void {
  lacking.clear();
}
