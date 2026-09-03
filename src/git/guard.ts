/**
 * Argument hygiene for everything that touches git or the filesystem.
 * Every ref, name, and path from the outside world passes one of these
 * before it appears in a spawn argument or a joined path — no exceptions.
 */

/** Owner and repo names: url-safe, no traversal, no flag injection. */
export function isSafeName(name: string): boolean {
  if (name.length === 0 || name.length > 100) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return false;
  if (name.includes("..")) return false;
  if (name.endsWith(".git") || name.endsWith(".lock")) return false;
  return true;
}

/**
 * Ref names, after git-check-ref-format: no leading dash (flag injection),
 * no ".." (range injection), no control chars or globbing metacharacters,
 * well-formed slash structure. Accepts both "main" and "refs/heads/main".
 */
export function isSafeRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 300) return false;
  if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/"))
    return false;
  if (ref.includes("..") || ref.includes("//") || ref.includes("@{"))
    return false;
  if (ref === "@") return false;
  if (/[\x00-\x20~^:?*[\\\x7f]/.test(ref)) return false;
  for (const part of ref.split("/")) {
    if (part.length === 0) return false;
    if (part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
      return false;
  }
  return true;
}

/** Full 40-char (or 64-char sha256) object ids only — no abbreviations. */
export function isSafeOid(oid: string): boolean {
  return /^[0-9a-f]{40}$/.test(oid) || /^[0-9a-f]{64}$/.test(oid);
}

/**
 * Paths inside a repository tree: relative, no traversal, no control bytes.
 * The control-byte rule is not cosmetic — a newline or a tab in a path is
 * a record separator to `update-index --index-info` and to half of git's
 * porcelain, so a path carrying one could be read as two entries.
 */
export function isSafeTreePath(path: string): boolean {
  if (path.length === 0 || path.length > 4096) return false;
  if (path.startsWith("/")) return false;
  if (/[\x00-\x1f\x7f]/.test(path)) return false;
  for (const part of path.split("/")) {
    if (part.length === 0 || part === "." || part === "..") return false;
  }
  return true;
}
