/**
 * Why no sandbox can be made here, as one named cause.
 *
 * `sandboxAvailable()` (src/crew/sandbox.ts) answers a failure as text: a
 * missing tool, or bwrap's last stderr line wrapped as "user namespaces are
 * refused here (…)" whatever bwrap actually refused. A skip line that
 * repeats that text cannot tell a host that cannot sandbox from a hole in
 * the gate, so `sandboxCause` reads it into one of three named causes —
 * user namespaces refused, a mount denied, a missing binary — and keeps the
 * probe's own text for anything else (#10745).
 *
 * Plain text in, plain data out; it never runs the probe itself.
 */

export type SandboxCause =
  | { kind: "user-namespaces"; words: string }
  | { kind: "mount"; words: string }
  | { kind: "missing-binary"; binary: string; words: string }
  | { kind: "unknown"; words: string };

/** The fixed words each cause opens with, as the skip line says them. */
const CAUSE_WORDS = {
  "user-namespaces": "user namespaces refused",
  mount: "a mount denied",
  "missing-binary": "missing binary",
} as const;

const MISSING = [
  /^(\S+) is not installed$/,
  /Executable not found in \$PATH: "([^"]+)"/,
  /ENOENT[^"]*?spawn (\S+)/,
  /^missing binary: (\S+)$/,
];

const NAMESPACE = /namespace|unshare|uid map|gid map|setgroups/i;
const MOUNT = /mount|pivot_root|make \/ slave|remount/i;

/** The bwrap line the probe wrapped, when it wrapped one. */
function bwrapLine(reason: string): string | undefined {
  const wrapped = /^user namespaces are refused here(?: \((.*)\))?$/s.exec(reason);
  if (wrapped !== null) return wrapped[1] ?? "";
  return /^bwrap: /.test(reason) ? reason : undefined;
}

/** One named cause for the probe's failure text. */
export function sandboxCause(reason: string): SandboxCause {
  const text = reason.trim();
  for (const pattern of MISSING) {
    const found = pattern.exec(text);
    if (found?.[1] !== undefined) {
      const binary = found[1].split("/").pop() ?? found[1];
      return {
        kind: "missing-binary",
        binary,
        words: `${CAUSE_WORDS["missing-binary"]}: ${binary}`,
      };
    }
  }
  const line = bwrapLine(text);
  if (line !== undefined) {
    const detail = line === "" ? "" : ` (${line})`;
    // A namespace refusal is read first: bwrap names the namespace when it
    // cannot make one, and only reaches its mounts once it has.
    if (line === "" || NAMESPACE.test(line))
      return {
        kind: "user-namespaces",
        words: `${CAUSE_WORDS["user-namespaces"]}${detail}`,
      };
    if (MOUNT.test(line))
      return { kind: "mount", words: `${CAUSE_WORDS.mount}${detail}` };
  }
  return { kind: "unknown", words: text };
}

/** The skip line's reason: one named cause. */
export function skipReason(cause: SandboxCause): string {
  return `no sandbox can be made here: ${cause.words}`;
}

